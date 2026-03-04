// static glass element template
// this the html/css that gets cloned into each element's shadow dom
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
              pointer-events: none; /* clicks pass through */
          }
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
            pointer-events: none; /* svg is invisible, just holds filter defs */
        }
        /* chromium: use svg displacement for refraction */
        .use-backdrop-filter .glass-inner {
            backdrop-filter: url(#liquidGlassFilter);
            -webkit-backdrop-filter: url(#liquidGlassFilter);
        }
        /* non-chromium: fallback to simple blur */
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
        <svg class="glass-filter-svg" id="glassFilterSvg">
            <defs>
                <filter id="liquidGlassFilter" x="-15%" y="-15%" width="130%" height="130%" color-interpolation-filters="sRGB">
                    <!-- same svg filter structure as button -->
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

// same surface equations as button component
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

// debounce helper for resize events
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

// main static liquid glass element
// same math as button but no animations/springs
// main static liquid glass element
// same math as button but no animations/springs
class LiquidGlass extends HTMLElement {
  constructor() {
    super();

    // create shadow dom
    this.attachShadow({ mode: "open" });
    this.shadowRoot.appendChild(glassTemplate.content.cloneNode(true));

    // grab element references
    this.glassElement = this.shadowRoot.getElementById("glassElement");
    this.glassInner = this.shadowRoot.getElementById("glassInner");
    this.glassFilterSvg = this.shadowRoot.getElementById("glassFilterSvg");

    // config storage
    this.CONFIG = {};

    // responsive mode: recalculate on window resize
    this.boundResizeHandler = null;
    this.debouncedResize = debounce(() => {
      if (this.CONFIG.isInitialized) {
        this.init();
      }
    }, 150);
  }

  // called when element added to page
  connectedCallback() {
    this.init();

    // set up resize listener for responsive mode
    if (this.getAttribute("responsive") === "true") {
      this.boundResizeHandler = this.debouncedResize.bind(this);
      window.addEventListener("resize", this.boundResizeHandler);
    }
  }

  // cleanup when element removed
  disconnectedCallback() {
    if (this.getAttribute("responsive") === "true" && this.boundResizeHandler) {
      window.removeEventListener("resize", this.boundResizeHandler);
    }
  }

  // attributes to watch for changes
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
    ];
  }
  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue || !this.CONFIG.isInitialized) {
      return;
    }
    this.init();
  }
  init() {
    const type = this.getAttribute("type") || "squircle";
    const isResponsive = this.getAttribute("responsive") === "true";
    let width, height, radius;
    const attrRadius = parseFloat(this.getAttribute("radius"));
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
    const feImages = this.shadowRoot.querySelectorAll("feImage");
    feImages.forEach((img) => {
      img.setAttribute("width", width.toString());
      img.setAttribute("height", height.toString());
    });
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
    this.detectBackdropFilterSupport();
    if (!this.glassElement.classList.contains("fallback-blur")) {
      this.updateFilter();
    }
  }
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
  updateFilter() {
    const surfaceFn = SurfaceEquations[this.CONFIG.surfaceType];
    const precomputed = this.calculateDisplacementMap1D(
      this.CONFIG.glassThickness,
      this.CONFIG.bezelWidth,
      surfaceFn,
      this.CONFIG.refractiveIndex,
    );
    this.CONFIG.maximumDisplacement = Math.max(...precomputed.map(Math.abs));
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
    const specularData = this.calculateSpecularHighlight(
      this.CONFIG.objectWidth,
      this.CONFIG.objectHeight,
      this.CONFIG.radius,
      this.CONFIG.bezelWidth,
    );
    const displacementUrl = this.imageDataToDataURL(displacementData);
    const specularUrl = this.imageDataToDataURL(specularData);
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

  // these below are identical to the button component's versions
  // see lg-button-component.js for detailed comments on the math

  // calculate 1d refraction curve using snell's law
  calculateDisplacementMap1D(
    glassThickness,
    bezelWidth,
    surfaceFn,
    refractiveIndex,
    samples = 128,
  ) {
    const eta = 1 / refractiveIndex;
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
      const dx = x < 1 ? 0.0001 : -0.0001;
      const y2 = surfaceFn(Math.max(0, Math.min(1, x + dx)));
      const derivative = (y2 - y) / dx;
      const magnitude = Math.sqrt(derivative * derivative + 1);
      const normal = [-derivative / magnitude, -1 / magnitude];
      const refracted = refract(normal[0], normal[1]);
      if (!refracted) {
        result.push(0);
      } else {
        const remainingHeightOnBezel = y * bezelWidth;
        const remainingHeight = remainingHeightOnBezel + glassThickness;
        result.push(refracted[0] * (remainingHeight / refracted[1]));
      }
    }
    return result;
  }

  // apply 1d curve to 2d shape
  // creates the actual displacement map
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
          const opacity =
            distanceToCenterSquared < radiusSquared
              ? 1
              : 1 -
                (Math.sqrt(distanceToCenterSquared) -
                  Math.sqrt(radiusSquared)) /
                  (Math.sqrt(radiusPlusOneSquared) - Math.sqrt(radiusSquared));
          const distanceFromCenter = Math.sqrt(distanceToCenterSquared);
          const distanceFromSide = radius - distanceFromCenter;
          const cos = distanceFromCenter > 0 ? x / distanceFromCenter : 0;
          const sin = distanceFromCenter > 0 ? y / distanceFromCenter : 0;
          const bezelRatio = Math.max(
            0,
            Math.min(1, distanceFromSide / bezelWidth),
          );
          const bezelIndex = Math.floor(bezelRatio * precomputedMap.length);
          const distance =
            precomputedMap[
              Math.max(0, Math.min(bezelIndex, precomputedMap.length - 1))
            ] || 0;
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

  // calculate bright rim highlight
  // simulates light reflecting off glass edge
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
          const dotProduct = Math.abs(
            cos * specularVector[0] + sin * specularVector[1],
          );
          const edgeRatio = Math.max(
            0,
            Math.min(1, distanceFromSide / specularThickness),
          );
          const sharpFalloff = Math.sqrt(1 - (1 - edgeRatio) * (1 - edgeRatio));
          const coefficient = dotProduct * sharpFalloff;
          const color = Math.min(255, 255 * coefficient);
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

  // convert imagedata to base64 url for svg <feImage>
  imageDataToDataURL(imageData) {
    const canvas = document.createElement("canvas");
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    const ctx = canvas.getContext("2d");
    ctx.putImageData(imageData, 0, 0);
    return canvas.toDataURL();
  }
}

// register the custom element
customElements.define("liquid-glass", LiquidGlass);
