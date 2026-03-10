// shadow dom template for the static glass element
// unlike the button variant, this one has no spring animations, its purely visual
const glassTemplate = document.createElement("template");
glassTemplate.innerHTML = `
  <style>
          :host {
              display: inline-block;
              contain: layout style;
          }
          .glass-element {
              position: relative;
              will-change: transform;
              overflow: hidden;
              transform-origin: 50% 50%;
              backface-visibility: hidden;
          }
          .glass-inner {
              width: 100%;
              height: 100%;
              border-radius: inherit;
              position: absolute;
              top: 0;
              left: 0;
              z-index: 3;
              pointer-events: none;
              background-color: var(--glass-tint, transparent);
          }
          /* sits above glass-inner so slotted content is always on top */
          .content-slot {
              display: var(--slot-display, flex);
              justify-content: var(--slot-justify, center);
              align-items: var(--slot-align, center);
              width: 100%;
              height: 100%;
              z-index: 4;
              position: relative;
          }
        .glass-filter-svg {
            position: absolute;
            width: 0;
            height: 0;
            overflow: hidden;
            pointer-events: none;
        }

        /* chromium only, svg backdrop-filter for full liquid glass effect */
        .use-backdrop-filter .glass-inner {
            backdrop-filter: url(#liquidGlassFilter);
            -webkit-backdrop-filter: url(#liquidGlassFilter);
        }

        /* non-chromium fallback, plain blur with a subtle inset border */
        .fallback-blur .glass-inner {
            backdrop-filter: blur(var(--fallback-blur, 15px)) saturate(1.2);
            -webkit-backdrop-filter: blur(var(--fallback-blur, 15px)) saturate(1.2);
            background-color: rgba(0,0,0,0);
            filter: saturate(110%);
        }
        .fallback-blur .glass-inner {
            box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.25);
        }
    </style>
    <div class="glass-element" id="glassElement">
        <!-- invisible svg, its filter is referenced by backdrop-filter url() on .glass-inner -->
        <svg class="glass-filter-svg" id="glassFilterSvg">
            <defs>
                <filter id="liquidGlassFilter" x="-15%" y="-15%" width="130%" height="130%" color-interpolation-filters="sRGB">
                    <feGaussianBlur id="filterBlur" in="SourceGraphic" stdDeviation="0.5" result="blurred"/>
                    <feImage id="displacementImage" href="" x="0" y="0" width="200" height="80" result="displacement_map" preserveAspectRatio="none"/>
                    <feDisplacementMap id="displacementMap" in="blurred" in2="displacement_map" scale="50" xChannelSelector="R" yChannelSelector="G" result="displaced"/>
                    <feColorMatrix in="displaced" type="saturate" values="1.3" result="displaced_saturated"/>
                    <feImage id="specularImage" href="" x="0" y="0" width="200" height="80" result="specular_layer" preserveAspectRatio="none"/>
                    <feComponentTransfer in="specular_layer" result="specular_faded">
                        <feFuncA id="specularAlpha" type="linear" slope="0.5"/>
                    </feComponentTransfer>
                    <feBlend in="specular_faded" in2="displaced_saturated" mode="screen"/>
                </filter>
            </defs>
        </svg>
        <div class="glass-inner" id="glassInner"></div>
        <div class="content-slot">
            <slot></slot>
        </div>
    </div>
`;

// math profiles for the glass edge shape, each fn maps x in [0,1] to a surface height
const SurfaceEquations = {
  convex_circle: (x) => Math.sqrt(1 - Math.pow(1 - x, 2)),
  convex_squircle: (x) => Math.pow(1 - Math.pow(1 - x, 4), 1 / 4),
  concave: (x) => 1 - Math.sqrt(1 - Math.pow(x, 2)),
  lip: (x) => {
    const convex = Math.pow(1 - Math.pow(1 - Math.min(x * 2, 1), 4), 1 / 4);
    const concave = 1 - Math.sqrt(1 - Math.pow(1 - x, 2)) + 0.1;
    const smootherstep =
      6 * Math.pow(x, 5) - 15 * Math.pow(x, 4) + 10 * Math.pow(x, 3);
    return convex * (1 - smootherstep) + concave * smootherstep;
  },
};

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// static glass container, same refraction pipeline as liquid-btn but without any spring animations
class LiquidGlass extends HTMLElement {
  constructor() {
    super();

    this.attachShadow({ mode: "open" });
    this.shadowRoot.appendChild(glassTemplate.content.cloneNode(true));

    this.glassElement = this.shadowRoot.getElementById("glassElement");
    this.glassInner = this.shadowRoot.getElementById("glassInner");
    this.glassFilterSvg = this.shadowRoot.getElementById("glassFilterSvg");

    this.CONFIG = {};

    this.boundResizeHandler = null;
    // debounced so we dont nuke performance on every resize tick
    this.debouncedResize = debounce(() => {
      if (this.CONFIG.isInitialized) {
        this.init();
      }
    }, 150);
  }

  connectedCallback() {
    this.init();

    // only attach resize listener when responsive mode is explicitly enabled
    if (this.getAttribute("responsive") === "true") {
      this.boundResizeHandler = this.debouncedResize.bind(this);
      window.addEventListener("resize", this.boundResizeHandler);
    }
  }

  disconnectedCallback() {
    if (this.getAttribute("responsive") === "true" && this.boundResizeHandler) {
      window.removeEventListener("resize", this.boundResizeHandler);
    }
  }

  static get observedAttributes() {
    return [
      "type",
      "width",
      "height",
      "radius",
      "radius-percent",
      "surface-type",
      "bezel-width",
      "bezel-width-percent",
      "glass-thickness",
      "refraction-scale",
      "specular-opacity",
      "blur",
      "fallback-blur",
      "flex-center",
      "responsive",
      "vw-width",
      "vh-height",
      "force-fallback",
      "font-size",
      "font-size-percent",
      "tint",
    ];
  }

  attributeChangedCallback(name, oldValue, newValue) {
    // bail if nothing changed or component hasnt mounted yet
    if (oldValue === newValue || !this.CONFIG.isInitialized) {
      return;
    }
    // any attr change triggers a full reinit, simpler than partial updates since its not animated
    this.init();
  }

  // resolves dimensions + config from attrs, then runs the glass rendering pipeline
  init() {
    const type = this.getAttribute("type") || "squircle";
    const isResponsive = this.getAttribute("responsive") === "true";
    let width, height, radius;
    const attrRadius = parseFloat(this.getAttribute("radius"));

    // responsive mode derives dimensions from viewport, falls back to type-based defaults
    if (isResponsive) {
      const vwWidth = parseFloat(this.getAttribute("vw-width"));
      const vhHeight = parseFloat(this.getAttribute("vh-height"));
      if (!isNaN(vwWidth) && !isNaN(vhHeight)) {
        width = Math.round((window.innerWidth * vwWidth) / 100);
        height = Math.round((window.innerHeight * vhHeight) / 100);
      } else if (!isNaN(vwWidth)) {
        width = Math.round((window.innerWidth * vwWidth) / 100);
        switch (type) {
          case "circle":
            height = width;
            break;
          case "pill":
            height = Math.round(width * 0.4);
            break;
          default:
            height = width;
            break;
        }
      } else {
        // no explicit vw/vh set, use large default fills per type
        switch (type) {
          case "pill":
            width = Math.round(window.innerWidth * 0.97);
            height = Math.round(window.innerHeight * 0.84);
            break;
          case "circle":
            const size = Math.round(
              Math.min(window.innerWidth, window.innerHeight) * 0.5,
            );
            width = size;
            height = size;
            break;
          default:
            width = Math.round(window.innerWidth * 0.5);
            height = Math.round(window.innerHeight * 0.5);
            break;
        }
      }
      const radiusPercent = parseFloat(this.getAttribute("radius-percent"));
      if (!isNaN(radiusPercent)) {
        radius = Math.round(Math.min(width, height) * (radiusPercent / 100));
      } else if (!isNaN(attrRadius)) {
        radius = Math.round(attrRadius);
      } else {
        switch (type) {
          case "pill":
            radius = Math.round(height / 2);
            break;
          case "circle":
            radius = Math.round(width / 2);
            break;
          default:
            radius = Math.round(Math.min(width, height) * 0.25);
            break;
        }
      }
    } else {
      // fixed mode, read px values from attrs with sensible defaults per type
      switch (type) {
        case "pill":
          width = parseFloat(this.getAttribute("width")) || 200;
          height = parseFloat(this.getAttribute("height")) || 80;
          radius = !isNaN(attrRadius) ? attrRadius : height / 2;
          break;
        case "circle":
          const size =
            parseFloat(this.getAttribute("width")) ||
            parseFloat(this.getAttribute("height")) ||
            120;
          width = size;
          height = size;
          radius = !isNaN(attrRadius) ? attrRadius : size / 2;
          break;
        case "squircle":
        default:
          width = parseFloat(this.getAttribute("width")) || 120;
          height = parseFloat(this.getAttribute("height")) || 120;
          radius = !isNaN(attrRadius)
            ? attrRadius
            : Math.min(width, height) * 0.25;
          break;
      }
    }
    this.glassElement.style.width = `${width}px`;
    this.glassElement.style.height = `${height}px`;
    this.glassElement.style.borderRadius = `${radius}px`;

    // flex-center="false" lets slotted content flow naturally instead of being centered
    const flexCenter = this.getAttribute("flex-center");
    if (flexCenter === "false") {
      this.glassElement.style.setProperty("--slot-display", "block");
      this.glassElement.style.setProperty("--slot-justify", "flex-start");
      this.glassElement.style.setProperty("--slot-align", "flex-start");
    } else {
      this.glassElement.style.setProperty("--slot-display", "flex");
      this.glassElement.style.setProperty("--slot-justify", "center");
      this.glassElement.style.setProperty("--slot-align", "center");
    }

    // sync feImage dimensions so displacement map covers the whole element
    const feImages = this.shadowRoot.querySelectorAll("feImage");
    feImages.forEach((img) => {
      img.setAttribute("width", width.toString());
      img.setAttribute("height", height.toString());
    });

    // bezel is the rim region where the refraction effect actually shows
    let bezelWidth;
    const bezelWidthPercent = parseFloat(
      this.getAttribute("bezel-width-percent"),
    );
    const bezelWidthAttr = parseFloat(this.getAttribute("bezel-width"));
    if (isResponsive && !isNaN(bezelWidthPercent)) {
      bezelWidth = Math.round(
        Math.min(width, height) * (bezelWidthPercent / 100),
      );
    } else if (!isNaN(bezelWidthAttr)) {
      bezelWidth = Math.round(bezelWidthAttr);
    } else {
      bezelWidth = isResponsive
        ? Math.round(Math.min(width, height) * 0.038)
        : 20;
    }

    this.CONFIG = {
      type: type,
      surfaceType: this.getAttribute("surface-type") || "convex_squircle",
      bezelWidth: bezelWidth,
      glassThickness: parseFloat(this.getAttribute("glass-thickness")) || 100,
      refractiveIndex: 1.5,
      refractionScale: parseFloat(this.getAttribute("refraction-scale")) || 1.5,
      specularOpacity: parseFloat(this.getAttribute("specular-opacity")) || 0.8,
      blur: parseFloat(this.getAttribute("blur")) || 5,
      fallbackBlurRadius: parseFloat(this.getAttribute("fallback-blur")) || 15,
      objectWidth: width,
      objectHeight: height,
      radius: radius,
      maximumDisplacement: 0,
      isInitialized: true,
    };
    this.glassElement.style.setProperty(
      "--fallback-blur",
      `${this.CONFIG.fallbackBlurRadius}px`,
    );

    const fontSizePercent = parseFloat(this.getAttribute("font-size-percent"));
    const fontSizeAttr = parseFloat(this.getAttribute("font-size"));
    if (isResponsive && !isNaN(fontSizePercent)) {
      this.style.fontSize = `${Math.round(Math.min(width, height) * (fontSizePercent / 100))}px`;
    } else if (!isNaN(fontSizeAttr)) {
      this.style.fontSize = `${fontSizeAttr}px`;
    } else {
      this.style.fontSize = "";
    }

    const tint = this.getAttribute("tint");
    this.glassElement.style.setProperty("--glass-tint", tint || "transparent");

    this.detectBackdropFilterSupport();
    if (!this.glassElement.classList.contains("fallback-blur")) {
      this.updateFilter();
    }
  }

  // checks if the browser supports svg backdrop-filter (chromium only)
  // falls back to simple blur on everything else
  detectBackdropFilterSupport() {
    if (this.getAttribute("force-fallback") === "true") {
      this.glassElement.classList.add("fallback-blur");
      if (this.glassFilterSvg) this.glassFilterSvg.remove();
      return;
    }
    const isChromium = !!window.chrome;
    const testEl = document.createElement("div");
    testEl.style.backdropFilter = "url(#test)";
    const supportsBackdropFilterUrl =
      testEl.style.backdropFilter.includes("url");
    if (isChromium && supportsBackdropFilterUrl) {
      this.glassElement.classList.add("use-backdrop-filter");
    } else {
      this.glassElement.classList.add("fallback-blur");
      if (this.glassFilterSvg) this.glassFilterSvg.remove();
    }
  }

  // runs the full refraction pipeline and pushes maps into the svg filter
  updateFilter() {
    const surfaceFn = SurfaceEquations[this.CONFIG.surfaceType];

    // compute 1d refraction profile along the bezel cross-section
    const precomputed = this.calculateDisplacementMap1D(
      this.CONFIG.glassThickness,
      this.CONFIG.bezelWidth,
      surfaceFn,
      this.CONFIG.refractiveIndex,
    );
    this.CONFIG.maximumDisplacement = Math.max(...precomputed.map(Math.abs));

    // expand 1d profile into full 2d imagedata for feDisplacementMap
    const displacementData = this.calculateDisplacementMap2D(
      this.CONFIG.objectWidth,
      this.CONFIG.objectHeight,
      this.CONFIG.objectWidth,
      this.CONFIG.objectHeight,
      this.CONFIG.radius,
      this.CONFIG.bezelWidth,
      this.CONFIG.maximumDisplacement || 1,
      precomputed,
    );

    // generate the rim specular highlight
    const specularData = this.calculateSpecularHighlight(
      this.CONFIG.objectWidth,
      this.CONFIG.objectHeight,
      this.CONFIG.radius,
      this.CONFIG.bezelWidth,
    );
    const displacementUrl = this.imageDataToDataURL(displacementData);
    const specularUrl = this.imageDataToDataURL(specularData);

    // push both maps into the svg filter as data urls
    this.shadowRoot
      .getElementById("displacementImage")
      .setAttribute("href", displacementUrl);
    this.shadowRoot
      .getElementById("specularImage")
      .setAttribute("href", specularUrl);
    this.shadowRoot
      .getElementById("displacementMap")
      .setAttribute(
        "scale",
        this.CONFIG.maximumDisplacement * this.CONFIG.refractionScale,
      );
    this.shadowRoot
      .getElementById("specularAlpha")
      .setAttribute("slope", this.CONFIG.specularOpacity);
    this.shadowRoot
      .getElementById("filterBlur")
      .setAttribute("stdDeviation", this.CONFIG.blur);
  }

  // snells law refraction along a 1d cross-section of the glass surface
  // returns lateral displacement values for each sample along the bezel
  calculateDisplacementMap1D(
    glassThickness,
    bezelWidth,
    surfaceFn,
    refractiveIndex,
    samples = 128,
  ) {
    const eta = 1 / refractiveIndex;

    // refract a ray through the surface normal, returns null on total internal reflection
    function refract(normalX, normalY) {
      const dot = normalY;
      const k = 1 - eta * eta * (1 - dot * dot);
      if (k < 0) return null;
      const kSqrt = Math.sqrt(k);
      return [
        -(eta * dot + kSqrt) * normalX,
        eta - (eta * dot + kSqrt) * normalY,
      ];
    }
    const result = [];
    for (let i = 0; i < samples; i++) {
      const x = i / samples;
      const y = surfaceFn(x);

      // numerically estimate the surface normal from the slope at this point
      const dx = x < 1 ? 0.0001 : -0.0001;
      const y2 = surfaceFn(Math.max(0, Math.min(1, x + dx)));
      const derivative = (y2 - y) / dx;
      const magnitude = Math.sqrt(derivative * derivative + 1);
      const normal = [-derivative / magnitude, -1 / magnitude];
      const refracted = refract(normal[0], normal[1]);
      if (!refracted) {
        result.push(0);
      } else {
        // project refracted ray through remaining glass height to get final lateral offset
        const remainingHeightOnBezel = y * bezelWidth;
        const remainingHeight = remainingHeightOnBezel + glassThickness;
        result.push(refracted[0] * (remainingHeight / refracted[1]));
      }
    }
    return result;
  }

  // maps the 1d refraction profile onto 2d imagedata
  // rg channels = x/y displacement, 128 = neutral (no displacement)
  // handles rounded rect corners and straight edges uniformly
  calculateDisplacementMap2D(
    canvasWidth,
    canvasHeight,
    objectWidth,
    objectHeight,
    radius,
    bezelWidth,
    maximumDisplacement,
    precomputedMap,
  ) {
    // init to neutral gray, pixels outside the bezel stay untouched
    const imageData = new ImageData(canvasWidth, canvasHeight);
    for (let i = 0; i < imageData.data.length; i += 4) {
      imageData.data[i] = 128;
      imageData.data[i + 1] = 128;
      imageData.data[i + 2] = 0;
      imageData.data[i + 3] = 255;
    }
    const radiusSquared = radius * radius;
    const radiusPlusOneSquared = (radius + 1) * (radius + 1);
    const radiusMinusBezelSquared = Math.max(
      0,
      (radius - bezelWidth) * (radius - bezelWidth),
    );
    const widthBetweenRadiuses = objectWidth - radius * 2;
    const heightBetweenRadiuses = objectHeight - radius * 2;
    const objectX = (canvasWidth - objectWidth) / 2;
    const objectY = (canvasHeight - objectHeight) / 2;
    for (let y1 = 0; y1 < objectHeight; y1++) {
      for (let x1 = 0; x1 < objectWidth; x1++) {
        const idx = ((objectY + y1) * canvasWidth + objectX + x1) * 4;

        // remap each pixel relative to the nearest corner, straight edges collapse to 0
        const isOnLeftSide = x1 < radius;
        const isOnRightSide = x1 >= objectWidth - radius;
        const isOnTopSide = y1 < radius;
        const isOnBottomSide = y1 >= objectHeight - radius;
        const x = isOnLeftSide
          ? x1 - radius
          : isOnRightSide
            ? x1 - radius - widthBetweenRadiuses
            : 0;
        const y = isOnTopSide
          ? y1 - radius
          : isOnBottomSide
            ? y1 - radius - heightBetweenRadiuses
            : 0;
        const distanceToCenterSquared = x * x + y * y;
        const isInBezel =
          distanceToCenterSquared <= radiusPlusOneSquared &&
          distanceToCenterSquared >= radiusMinusBezelSquared;
        if (isInBezel) {
          // feather at the outer edge for antialiasing
          const opacity =
            distanceToCenterSquared < radiusSquared
              ? 1
              : 1 -
                (Math.sqrt(distanceToCenterSquared) -
                  Math.sqrt(radiusSquared)) /
                  (Math.sqrt(radiusPlusOneSquared) - Math.sqrt(radiusSquared));
          const distanceFromCenter = Math.sqrt(distanceToCenterSquared);
          const distanceFromSide = radius - distanceFromCenter;

          // unit vector from corner center outward, this is the displacement direction
          const cos = distanceFromCenter > 0 ? x / distanceFromCenter : 0;
          const sin = distanceFromCenter > 0 ? y / distanceFromCenter : 0;

          // look up displacement magnitude from the precomputed 1d profile
          const bezelRatio = Math.max(
            0,
            Math.min(1, distanceFromSide / bezelWidth),
          );
          const bezelIndex = Math.floor(bezelRatio * precomputedMap.length);
          const distance =
            precomputedMap[
              Math.max(0, Math.min(bezelIndex, precomputedMap.length - 1))
            ] || 0;

          // normalize to [-1, 1] then encode into [0, 255] for the svg filter
          const dX =
            maximumDisplacement > 0
              ? (-cos * distance) / maximumDisplacement
              : 0;
          const dY =
            maximumDisplacement > 0
              ? (-sin * distance) / maximumDisplacement
              : 0;
          imageData.data[idx] = Math.max(
            0,
            Math.min(255, 128 + dX * 127 * opacity),
          );
          imageData.data[idx + 1] = Math.max(
            0,
            Math.min(255, 128 + dY * 127 * opacity),
          );
          imageData.data[idx + 2] = 0;
          imageData.data[idx + 3] = 255;
        }
      }
    }
    return imageData;
  }

  // generates the rim specular highlight, white glow on the edge aligned with the light direction
  calculateSpecularHighlight(
    objectWidth,
    objectHeight,
    radius,
    bezelWidth,
    specularAngle = Math.PI / 3,
  ) {
    const imageData = new ImageData(objectWidth, objectHeight);
    const specularVector = [Math.cos(specularAngle), Math.sin(specularAngle)];
    const specularThickness = 1.5;
    const radiusSquared = radius * radius;
    const radiusPlusOneSquared = (radius + 1) * (radius + 1);
    const radiusMinusSpecularSquared = Math.max(
      0,
      (radius - specularThickness) * (radius - specularThickness),
    );
    const widthBetweenRadiuses = objectWidth - radius * 2;
    const heightBetweenRadiuses = objectHeight - radius * 2;
    for (let y1 = 0; y1 < objectHeight; y1++) {
      for (let x1 = 0; x1 < objectWidth; x1++) {
        const idx = (y1 * objectWidth + x1) * 4;
        const isOnLeftSide = x1 < radius;
        const isOnRightSide = x1 >= objectWidth - radius;
        const isOnTopSide = y1 < radius;
        const isOnBottomSide = y1 >= objectHeight - radius;
        const x = isOnLeftSide
          ? x1 - radius
          : isOnRightSide
            ? x1 - radius - widthBetweenRadiuses
            : 0;
        const y = isOnTopSide
          ? y1 - radius
          : isOnBottomSide
            ? y1 - radius - heightBetweenRadiuses
            : 0;
        const distanceToCenterSquared = x * x + y * y;

        // only paint within the thin specular band at the very edge
        const isNearEdge =
          distanceToCenterSquared <= radiusPlusOneSquared &&
          distanceToCenterSquared >= radiusMinusSpecularSquared;
        if (isNearEdge) {
          const distanceFromCenter = Math.sqrt(distanceToCenterSquared);
          const distanceFromSide = radius - distanceFromCenter;
          const opacity =
            distanceToCenterSquared < radiusSquared
              ? 1
              : 1 -
                (distanceFromCenter - Math.sqrt(radiusSquared)) /
                  (Math.sqrt(radiusPlusOneSquared) - Math.sqrt(radiusSquared));
          const cos = distanceFromCenter > 0 ? x / distanceFromCenter : 0;
          const sin = distanceFromCenter > 0 ? -y / distanceFromCenter : 0;

          // how aligned is this edge segment with the light source direction
          const dotProduct = Math.abs(
            cos * specularVector[0] + sin * specularVector[1],
          );
          const edgeRatio = Math.max(
            0,
            Math.min(1, distanceFromSide / specularThickness),
          );

          // sharp falloff keeps the highlight tight to the rim
          const sharpFalloff = Math.sqrt(1 - (1 - edgeRatio) * (1 - edgeRatio));
          const coefficient = dotProduct * sharpFalloff;
          const color = Math.min(255, 255 * coefficient);

          // squaring the alpha makes the highlight punchier and more physically plausible
          const finalOpacity = Math.min(255, color * coefficient * opacity);
          imageData.data[idx] = color;
          imageData.data[idx + 1] = color;
          imageData.data[idx + 2] = color;
          imageData.data[idx + 3] = finalOpacity;
        }
      }
    }
    return imageData;
  }

  // bakes imagedata into a base64 data url via an offscreen canvas
  imageDataToDataURL(imageData) {
    const canvas = document.createElement("canvas");
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    const ctx = canvas.getContext("2d");
    ctx.putImageData(imageData, 0, 0);
    return canvas.toDataURL();
  }
}

customElements.define("liquid-glass", LiquidGlass);
