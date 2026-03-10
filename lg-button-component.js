// shadow dom template for the button, glass-inner is the actual glass layer sitting on top
const buttonTemplate = document.createElement("template");
buttonTemplate.innerHTML = `
    <style>
        :host {
            display: inline-block;
            -webkit-tap-highlight-color: transparent;
            contain: layout style;
        }
        .glass-button {
            position: relative;
            cursor: pointer;
            touch-action: none;
            user-select: none;

            transform-origin: 50% 50%;
        }
        .glass-inner {
            width: 100%;
            height: 100%;
            border-radius: inherit;
            overflow: hidden;
            position: absolute;
            top: 0;
            left: 0;
            z-index: 3;
            pointer-events: none;
            display: flex;
            justify-content: center;
            align-items: center;
            background-color: var(--glass-tint, transparent);
        }
        .button-text {
            color: var(--btn-color, white);
            font-size: var(--button-font-size, 1.8rem);
            text-shadow: 0px 0px 15px rgba(0,0,0,0.5);
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

        /* non-chromium fallback, just blur + saturate, no displacement */
        .fallback-blur .glass-inner {
            backdrop-filter: blur(var(--fallback-blur, 15px)) saturate(1.2);
            -webkit-backdrop-filter: blur(var(--fallback-blur, 15px)) saturate(1.2);
            background-color: var(--btn-bg, rgba(0,0,0,0));
            filter: saturate(110%);
            box-shadow: inset 0 0 0 1px var(--btn-border, rgba(255, 255, 255, 0.25));
        }
    </style>
    <div class="glass-button" id="glassButton">
        <!-- svg lives here but is invisible (0x0), its filter gets applied via backdrop-filter url() -->
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
        <div class="glass-inner" id="glassInner">
            <span class="button-text">
                <slot>Button</slot>
            </span>
        </div>
    </div>
`;

// math profiles for the glass edge shape, each fn maps x in [0,1] to a height value
// these define how the surface curves from the edge inward, used for refraction calc
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

// simple spring physics, drives all the hover/press animations
// stiffness controls how snappy it is, damping controls how much it overshoots
class Spring {
  constructor(value, stiffness = 300, damping = 20) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.stiffness = stiffness;
    this.damping = damping;
  }

  setTarget(target) {
    this.target = target;
  }

  // euler integration step, call this every frame with delta time
  update(dt) {
    const force = (this.target - this.value) * this.stiffness;
    const dampingForce = this.velocity * this.damping;
    this.velocity += (force - dampingForce) * dt;
    this.value += this.velocity * dt;
    // snap to rest if close enough, avoids infinite micro-oscillation
    if (
      Math.abs(this.target - this.value) < 0.0001 &&
      Math.abs(this.velocity) < 0.001
    ) {
      this.value = this.target;
      this.velocity = 0;
    }
    return this.value;
  }

  isSettled() {
    return (
      Math.abs(this.target - this.value) < 0.0001 &&
      Math.abs(this.velocity) < 0.001
    );
  }
}

// custom element for the animated glass button, handles sizing, refraction maps, and spring-based interactions
class LiquidButton extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.appendChild(buttonTemplate.content.cloneNode(true));
    this.glassButton = this.shadowRoot.getElementById("glassButton");
    this.glassInner = this.shadowRoot.getElementById("glassInner");
    this.glassFilterSvg = this.shadowRoot.getElementById("glassFilterSvg");
    this.CONFIG = {};
    this.springs = {};
    this.animationFrameId = null;
    this.boundResizeHandler = null;
    // debounced so we dont spam reinit on every resize pixel
    this.debouncedResize = debounce(() => {
      if (this.CONFIG.isInitialized) {
        this.init();
      }
    }, 150);
  }

  connectedCallback() {
    this.init();

    // only attach resize listener if explicitly opted into responsive mode
    if (this.getAttribute("responsive") === "true") {
      this.boundResizeHandler = this.debouncedResize.bind(this);
      window.addEventListener("resize", this.boundResizeHandler);
    }
  }

  disconnectedCallback() {
    if (this.getAttribute("responsive") === "true" && this.boundResizeHandler) {
      window.removeEventListener("resize", this.boundResizeHandler);
    }
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
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
      "responsive",
      "vw-width",
      "vh-height",
      "force-fallback",
      "font-size",
      "font-size-percent",
      "spring-timing",
      "tint",
    ];
  }

  attributeChangedCallback(name, oldValue, newValue) {
    // bail early if nothing changed or component hasnt initialized yet
    if (oldValue === newValue || !this.CONFIG.isInitialized) {
      return;
    }

    // structural attrs require a full reinit (dimensions change everything)
    if (
      [
        "type",
        "width",
        "height",
        "radius",
        "radius-percent",
        "responsive",
        "vw-width",
        "vh-height",
      ].includes(name)
    ) {
      this.init();
      return;
    }

    // for everything else just patch CONFIG and refresh the filter
    const configKey = name.replace(/-(\w)/g, (_, c) => c.toUpperCase());

    this.CONFIG[configKey] = parseFloat(newValue) || newValue;

    if (name === "fallback-blur") {
      this.glassButton.style.setProperty(
        "--fallback-blur",
        `${this.CONFIG.fallbackBlurRadius}px`,
      );
    }

    if (!this.glassButton.classList.contains("fallback-blur")) {
      this.updateFilter();
    }
  }

  // resolves all dimensions + config from attributes, then kicks off the glass rendering pipeline
  init() {
    const type = this.getAttribute("type") || "squircle";
    const isResponsive = this.getAttribute("responsive") === "true";
    let width, height, radius;
    const attrRadius = parseFloat(this.getAttribute("radius"));

    // responsive mode reads from viewport units, falling back to sane type-based defaults
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
            width = Math.round(window.innerWidth * 0.1);
            height = Math.round(window.innerHeight * 0.05);
            break;
          case "circle":
            const size = Math.round(
              Math.min(window.innerWidth, window.innerHeight) * 0.1,
            );
            width = size;
            height = size;
            break;
          default:
            width = Math.round(window.innerWidth * 0.1);
            height = Math.round(window.innerHeight * 0.1);
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
      // fixed mode, just read px values from attrs with sensible defaults per type
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
    this.glassButton.style.width = `${width}px`;
    this.glassButton.style.height = `${height}px`;
    this.glassButton.style.borderRadius = `${radius}px`;

    // sync feImage sizes to match the button, displacement map has to cover the whole element
    const feImages = this.shadowRoot.querySelectorAll("feImage");
    feImages.forEach((img) => {
      img.setAttribute("width", width.toString());
      img.setAttribute("height", height.toString());
    });

    // bezel is the rim region where refraction actually happens
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
      isHovering: false,
      isPressed: false,
      isInitialized: true,
    };

    this.glassButton.style.setProperty(
      "--fallback-blur",
      `${this.CONFIG.fallbackBlurRadius}px`,
    );

    const fontSizePercent = parseFloat(this.getAttribute("font-size-percent"));
    const fontSizeAttr = parseFloat(this.getAttribute("font-size"));
    let fontSize;
    if (isResponsive && !isNaN(fontSizePercent)) {
      fontSize = Math.round(Math.min(width, height) * (fontSizePercent / 100));
    } else if (!isNaN(fontSizeAttr)) {
      fontSize = fontSizeAttr;
    }
    if (fontSize) {
      this.glassButton.style.setProperty("--button-font-size", `${fontSize}px`);
    } else {
      this.glassButton.style.removeProperty("--button-font-size");
    }

    // springs for each animated property, stiffness/damping tuned per feel
    this.springs = {
      scale: new Spring(1, 150, 6),
      shadowOffsetX: new Spring(0, 500, 40),
      shadowOffsetY: new Spring(4, 500, 40),
      shadowBlur: new Spring(12, 500, 40),
      shadowAlpha: new Spring(0.15, 500, 40),
      // boosts refraction distortion on press
      refractionBoost: new Spring(0.8, 100, 5),
      // rotates the specular highlight around the edge on hover/press
      specularAngle: new Spring(Math.PI / 3, 300, 30),
    };
    const tint = this.getAttribute("tint");
    this.glassButton.style.setProperty("--glass-tint", tint || "transparent");

    this.detectBackdropFilterSupport();
    if (!this.glassButton.classList.contains("fallback-blur")) {
      this.updateFilter(false);
    }
    this.initHover();
    this.initPress();

    this.startAnimationLoop();
  }

  // checks if the browser can do svg backdrop-filter (chromium only)
  // everything else falls back to a plain blur
  detectBackdropFilterSupport() {
    if (this.getAttribute("force-fallback") === "true") {
      this.glassButton.classList.add("fallback-blur");
      if (this.glassFilterSvg) this.glassFilterSvg.remove();
      return;
    }
    const isChromium = !!window.chrome;
    const testEl = document.createElement("div");
    testEl.style.backdropFilter = "url(#test)";
    const supportsBackdropFilterUrl =
      testEl.style.backdropFilter.includes("url");
    if (isChromium && supportsBackdropFilterUrl) {
      this.glassButton.classList.add("use-backdrop-filter");
    } else {
      this.glassButton.classList.add("fallback-blur");
      if (this.glassFilterSvg) this.glassFilterSvg.remove();
    }
  }

  // full filter rebuild, runs the refraction pipeline and pushes results into the svg filter
  updateFilter(updateScale = true) {
    const surfaceFn = SurfaceEquations[this.CONFIG.surfaceType];

    // compute 1d refraction profile along the bezel edge
    const precomputed = this.calculateDisplacementMap1D(
      this.CONFIG.glassThickness,
      this.CONFIG.bezelWidth,
      surfaceFn,
      this.CONFIG.refractiveIndex,
    );

    this.CONFIG.maximumDisplacement = Math.max(...precomputed.map(Math.abs));

    // project that 1d profile onto a 2d imagedata (handles corners/squircle shape)
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

    // push the generated maps into the svg filter as data urls
    this.shadowRoot
      .getElementById("displacementImage")
      .setAttribute("href", displacementUrl);
    this.shadowRoot
      .getElementById("specularImage")
      .setAttribute("href", specularUrl);

    if (updateScale) {
      this.shadowRoot
        .getElementById("displacementMap")
        .setAttribute(
          "scale",
          this.CONFIG.maximumDisplacement * this.CONFIG.refractionScale,
        );
    }

    this.shadowRoot
      .getElementById("specularAlpha")
      .setAttribute("slope", this.CONFIG.specularOpacity);
    this.shadowRoot
      .getElementById("filterBlur")
      .setAttribute("stdDeviation", this.CONFIG.blur);
  }

  // main animation loop, drives spring physics and applies state to the DOM
  animationLoop(timestamp) {
    if (!this._lastTimestamp) this._lastTimestamp = timestamp;

    // "fixed" timing uses a constant dt, useful for deterministic testing
    const useFixedTiming = this.getAttribute("spring-timing") === "fixed";
    const rawDt = useFixedTiming
      ? Math.min(0.032, 1 / 60)
      : Math.min((timestamp - this._lastTimestamp) / 1000, 0.05);
    this._lastTimestamp = timestamp;

    // set spring targets based on current interaction state
    if (this.CONFIG.isPressed) {
      this.springs.scale.setTarget(0.98);
      this.springs.shadowOffsetY.setTarget(8);
      this.springs.shadowBlur.setTarget(16);
      this.springs.shadowAlpha.setTarget(0.25);
      this.springs.refractionBoost.setTarget(1.5);
      this.springs.specularAngle.setTarget((-Math.PI * 4) / 3);
    } else if (this.CONFIG.isHovering) {
      this.springs.scale.setTarget(1.05);
      this.springs.shadowOffsetY.setTarget(16);
      this.springs.shadowBlur.setTarget(24);
      this.springs.shadowAlpha.setTarget(0.22);
      this.springs.refractionBoost.setTarget(1.0);
      this.springs.specularAngle.setTarget(-Math.PI / 3);
    } else {
      this.springs.scale.setTarget(1);
      this.springs.shadowOffsetY.setTarget(4);
      this.springs.shadowBlur.setTarget(12);
      this.springs.shadowAlpha.setTarget(0.15);
      this.springs.refractionBoost.setTarget(0.8);
      this.springs.specularAngle.setTarget(Math.PI / 3);
    }

    // sub-step the spring integration for stability at high stiffness values
    const MAX_SUBSTEP = 1 / 120;
    const springList = Object.values(this.springs);
    let remaining = rawDt;
    while (remaining > 0) {
      const stepDt = Math.min(remaining, MAX_SUBSTEP);
      for (const s of springList) s.update(stepDt);
      remaining -= stepDt;
    }

    const scale = this.springs.scale.value;
    const shadowOffsetX = this.springs.shadowOffsetX.value;
    const shadowOffsetY = this.springs.shadowOffsetY.value;
    const shadowBlur = this.springs.shadowBlur.value;
    const shadowAlpha = this.springs.shadowAlpha.value;
    const refractionBoost = this.springs.refractionBoost.value;
    const specularAngleRaw = this.springs.specularAngle.value;

    // normalize specular angle to [-pi, pi] to keep it from spinning off to infinity
    let specularAngle = specularAngleRaw % (Math.PI * 2);
    if (specularAngle > Math.PI) specularAngle -= Math.PI * 2;
    if (specularAngle < -Math.PI) specularAngle += Math.PI * 2;

    // skip dom writes if values havent actually changed, saves paint calls
    const roundedScale = Math.round(scale * 10000) / 10000;
    if (roundedScale !== this._lastScale) {
      if (roundedScale !== 1 || this._lastScale !== undefined) {
        this.glassButton.style.transform =
          roundedScale === 1 ? "" : `scale(${roundedScale})`;
      }
      this._lastScale = roundedScale;
    }
    const shadowValue = `${Math.round(shadowOffsetX * 10) / 10}px ${Math.round(shadowOffsetY * 10) / 10}px ${Math.round(shadowBlur * 10) / 10}px rgba(0, 0, 0, ${Math.round(shadowAlpha * 1000) / 1000})`;
    if (shadowValue !== this._lastShadow) {
      this.glassButton.style.boxShadow = shadowValue;
      this._lastShadow = shadowValue;
    }

    if (!this.glassButton.classList.contains("fallback-blur")) {
      // only update svg filter scale when it shifts enough to matter visually
      const dynamicRefractionScale =
        this.CONFIG.refractionScale * refractionBoost;
      const newFilterScale =
        this.CONFIG.maximumDisplacement * dynamicRefractionScale;

      if (Math.abs(newFilterScale - (this._lastFilterScale ?? -1)) > 0.5) {
        const displacementMap =
          this.shadowRoot.getElementById("displacementMap");
        if (displacementMap) {
          displacementMap.setAttribute("scale", newFilterScale);
        }
        this._lastFilterScale = newFilterScale;
      }

      // regenerate the specular highlight image only when angle changes meaningfully
      const angleDiff = Math.abs(
        specularAngle - (this._lastSpecularAngle ?? Math.PI / 3),
      );
      if (angleDiff > 0.08) {
        const specularData = this.calculateSpecularHighlight(
          this.CONFIG.objectWidth,
          this.CONFIG.objectHeight,
          this.CONFIG.radius,
          this.CONFIG.bezelWidth,
          specularAngle,
        );
        const specularUrl = this.imageDataToDataURL(specularData);
        this.shadowRoot
          .getElementById("specularImage")
          .setAttribute("href", specularUrl);
        this._lastSpecularAngle = specularAngle;
      }
    }

    const allSettled = Object.values(this.springs).every((s) => s.isSettled());

    // clamp specular angle once settled to prevent accumulated float drift
    if (allSettled && this.springs.specularAngle.value > Math.PI * 2) {
      const normalized = this.springs.specularAngle.value % (Math.PI * 2);
      this.springs.specularAngle.value = normalized;
      this.springs.specularAngle.target = normalized;
    }

    // self-terminate the loop when all springs have settled, restarts on next interaction
    if (!allSettled) {
      this.animationFrameId = requestAnimationFrame(
        this.animationLoop.bind(this),
      );
    } else {
      this.animationFrameId = null;
    }
  }

  // kick off the rAF loop only if its not already running
  startAnimationLoop() {
    if (!this.animationFrameId) {
      this._lastTimestamp = null;
      this._lastFilterScale = null;
      this._lastSpecularAngle = null;
      this._lastScale = undefined;
      this._lastShadow = undefined;
      this.animationFrameId = requestAnimationFrame(
        this.animationLoop.bind(this),
      );
    }
  }

  initHover() {
    this.glassButton.addEventListener("mouseenter", () => {
      this.CONFIG.isHovering = true;
      this.startAnimationLoop();
    });
    this.glassButton.addEventListener("mouseleave", () => {
      this.CONFIG.isHovering = false;
      this.startAnimationLoop();
    });
  }

  initPress() {
    this.glassButton.addEventListener("mousedown", () => {
      this.CONFIG.isPressed = true;
      this.startAnimationLoop();
    });
    // listen on window so release outside button still clears press state
    window.addEventListener("mouseup", () => {
      if (this.CONFIG.isPressed) {
        this.CONFIG.isPressed = false;
        this.startAnimationLoop();
      }
    });
  }

  // snells law refraction along a 1d cross-section of the glass surface
  // returns an array of horizontal displacement values, one per sample along the bezel
  calculateDisplacementMap1D(
    glassThickness,
    bezelWidth,
    surfaceFn,
    refractiveIndex,
    samples = 128,
  ) {
    const eta = 1 / refractiveIndex;

    // refract a ray through the surface normal using snells law
    // returns null if total internal reflection occurs (k < 0)
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

      // numerically estimate the surface normal from the slope of the surface fn
      const dx = x < 1 ? 0.0001 : -0.0001;
      const y2 = surfaceFn(Math.max(0, Math.min(1, x + dx)));
      const derivative = (y2 - y) / dx;
      const magnitude = Math.sqrt(derivative * derivative + 1);
      const normal = [-derivative / magnitude, -1 / magnitude];

      const refracted = refract(normal[0], normal[1]);
      if (!refracted) {
        result.push(0);
      } else {
        // project the refracted ray forward by the remaining glass height to get lateral offset
        const remainingHeightOnBezel = y * bezelWidth;
        const remainingHeight = remainingHeightOnBezel + glassThickness;

        result.push(refracted[0] * (remainingHeight / refracted[1]));
      }
    }
    return result;
  }

  // expands the 1d displacement profile into a full 2d imagedata
  // rg channels encode x/y displacement, 128 = no displacement (neutral gray)
  // handles all 4 corners and straight edges of the rounded rect
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
    // start with neutral gray (no displacement)
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

        // remap coords relative to the nearest corner center
        // straight edges collapse to 0 on the perpendicular axis
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
          // feather at the outer edge of the radius for antialiasing
          const opacity =
            distanceToCenterSquared < radiusSquared
              ? 1
              : 1 -
                (Math.sqrt(distanceToCenterSquared) -
                  Math.sqrt(radiusSquared)) /
                  (Math.sqrt(radiusPlusOneSquared) - Math.sqrt(radiusSquared));
          const distanceFromCenter = Math.sqrt(distanceToCenterSquared);
          const distanceFromSide = radius - distanceFromCenter;

          // unit vector from corner center to this pixel, direction of displacement
          const cos = distanceFromCenter > 0 ? x / distanceFromCenter : 0;
          const sin = distanceFromCenter > 0 ? y / distanceFromCenter : 0;

          // look up displacement amount from the precomputed 1d profile
          const bezelRatio = Math.max(
            0,
            Math.min(1, distanceFromSide / bezelWidth),
          );
          const bezelIndex = Math.floor(bezelRatio * precomputedMap.length);
          const distance =
            precomputedMap[
              Math.max(0, Math.min(bezelIndex, precomputedMap.length - 1))
            ] || 0;

          // normalize displacement to [-1, 1] then encode into [0, 255]
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

  // generates the white rim highlight that makes the glass look physically lit
  // brightness is driven by how much the edge normal aligns with the light direction
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
        // only paint within the thin specular rim band
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
          // tangent direction at this edge point
          const cos = distanceFromCenter > 0 ? x / distanceFromCenter : 0;
          const sin = distanceFromCenter > 0 ? -y / distanceFromCenter : 0;
          // dot product tells us how aligned this edge segment is with the light direction
          const dotProduct = Math.abs(
            cos * specularVector[0] + sin * specularVector[1],
          );
          const edgeRatio = Math.max(
            0,
            Math.min(1, distanceFromSide / specularThickness),
          );
          // sharp falloff keeps the specular tight to the very edge
          const sharpFalloff = Math.sqrt(1 - (1 - edgeRatio) * (1 - edgeRatio));
          const coefficient = dotProduct * sharpFalloff;
          const color = Math.min(255, 255 * coefficient);
          // alpha is squared for a tighter, more focused highlight
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

customElements.define("liquid-btn", LiquidButton);
