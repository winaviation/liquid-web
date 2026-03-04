// button template
// this the html/css that gets cloned into each button's shadow dom
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
            touch-action: none; /* disable touch scrolling on button */
            user-select: none;
            will-change: transform;
            overflow: hidden;
            transform-origin: 50% 50%;
            backface-visibility: hidden; /* hide back face during 3d transforms */
        }
        .glass-inner {
            width: 100%;
            height: 100%;
            border-radius: inherit;
            position: absolute;
            top: 0;
            left: 0;
            z-index: 3;
            pointer-events: none; /* clicks pass through to button below */
            display: flex;
            justify-content: center;
            align-items: center;
        }
        .button-text {
            color: white;
            font-size: var(--button-font-size, 1.8rem);
            text-shadow: 0px 0px 15px rgba(0,0,0,0.5);
        }
        .glass-filter-svg {
            position: absolute;
            width: 0;
            height: 0;
            overflow: hidden;
            pointer-events: none; /* svg is invisible, just holds the filter definitions */
        }
        /* chromium browsers: use svg displacement map for refraction */
        .use-backdrop-filter .glass-inner {
            backdrop-filter: url(#liquidGlassFilter);
            -webkit-backdrop-filter: url(#liquidGlassFilter);
        }
        /* non-chromium browsers: fallback to simple blur */
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
    <div class="glass-button" id="glassButton">
        <svg class="glass-filter-svg" id="glassFilterSvg">
            <defs>
                <filter id="liquidGlassFilter" x="-15%" y="-15%" width="130%" height="130%" color-interpolation-filters="sRGB">
                    <!-- blur the background first -->
                    <feGaussianBlur id="filterBlur" in="SourceGraphic" stdDeviation="0.5" result="blurred"/>
                    <!-- displacement map: defines how much to distort each pixel -->
                    <feImage id="displacementImage" href="" x="0" y="0" width="200" height="80" result="displacement_map" preserveAspectRatio="none"/>
                    <!-- apply the displacement to create refraction effect -->
                    <feDisplacementMap id="displacementMap" in="blurred" in2="displacement_map" scale="50" xChannelSelector="R" yChannelSelector="G" result="displaced"/>
                    <!-- bump up saturation for that glassy look -->
                    <feColorMatrix in="displaced" type="saturate" values="1.3" result="displaced_saturated"/>
                    <!-- specular highlight: the bright rim effect -->
                    <feImage id="specularImage" href="" x="0" y="0" width="200" height="80" result="specular_layer" preserveAspectRatio="none"/>
                    <!-- fade the specular based on opacity setting -->
                    <feComponentTransfer in="specular_layer" result="specular_faded">
                        <feFuncA id="specularAlpha" type="linear" slope="0.5"/>
                    </feComponentTransfer>
                    <!-- blend specular on top using screen mode -->
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

// mathematical curves that define the glass surface shape
// these control how the glass edge bends, which affects the refraction
const SurfaceEquations = {
  // circular bulge
  // simple quarter circle
  convex_circle: (x) => Math.sqrt(1 - Math.pow(1 - x, 2)),
  // squircle bulge
  // smoother than circle, looks more modern
  convex_squircle: (x) => Math.pow(1 - Math.pow(1 - x, 4), 1 / 4),
  // concave
  // curves inward (kinda weird)
  concave: (x) => 1 - Math.sqrt(1 - Math.pow(x, 2)),
  // lip
  // has a raised edge like a drinking glass rim (also weird)
  lip: (x) => {
    const convex = Math.pow(1 - Math.pow(1 - Math.min(x * 2, 1), 4), 1 / 4);
    const concave = 1 - Math.sqrt(1 - Math.pow(1 - x, 2)) + 0.1;
    const smootherstep =
      6 * Math.pow(x, 5) - 15 * Math.pow(x, 4) + 10 * Math.pow(x, 3);
    return convex * (1 - smootherstep) + concave * smootherstep;
  },
};

// debounce helper
// prevents function from being called too many times
// used for resize events so we dont recalculate on every single pixel of resize
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

// spring physics for smooth animations
// way better than css transitions for interactive stuff
// spring physics for smooth animations
// way better than css transitions for interactive stuff
class Spring {
  constructor(value, stiffness = 300, damping = 20) {
    this.value = value; // current value
    this.target = value; // where we are heading
    this.velocity = 0; // how fast we are moving
    this.stiffness = stiffness; // how hard it pulls toward target (higher = snappier)
    this.damping = damping; // how much it resists motion (higher = less bouncy)
  }

  // change where the spring is heading
  setTarget(target) {
    this.target = target;
  }

  // update the spring physics (call this every frame)
  update(dt) {
    // calculate spring force (hooke's law)
    const force = (this.target - this.value) * this.stiffness;
    // calculate damping force (opposes motion)
    const dampingForce = this.velocity * this.damping;
    // update velocity based on net force
    this.velocity += (force - dampingForce) * dt;
    // update position based on velocity
    this.value += this.velocity * dt;

    // snap to target if very close (doesnt really fix all micro-oscillations and jitter but at least reduce them ig)
    if (
      Math.abs(this.target - this.value) < 0.0001 &&
      Math.abs(this.velocity) < 0.001
    ) {
      this.value = this.target;
      this.velocity = 0;
    }

    return this.value;
  }

  // check if spring has stopped moving (within threshold)
  isSettled() {
    return (
      Math.abs(this.target - this.value) < 0.0001 &&
      Math.abs(this.velocity) < 0.001
    );
  }
}

// main button web component
class LiquidButton extends HTMLElement {
  constructor() {
    super();

    // create shadow dom for style encapsulation
    this.attachShadow({ mode: "open" });
    this.shadowRoot.appendChild(buttonTemplate.content.cloneNode(true));

    // grab references to elements we'll need later
    this.glassButton = this.shadowRoot.getElementById("glassButton");
    this.glassInner = this.shadowRoot.getElementById("glassInner");
    this.glassFilterSvg = this.shadowRoot.getElementById("glassFilterSvg");

    // config and state
    this.CONFIG = {}; // stores all settings
    this.springs = {}; // stores spring objects for animations
    this.animationFrameId = null; // for canceling animation loop

    // responsive mode: recalculate dimensions on window resize
    this.boundResizeHandler = null;
    this.debouncedResize = debounce(() => {
      if (this.CONFIG.isInitialized) {
        this.init();
      }
    }, 150); // wait 150ms after last resize before recalculating
  }

  // called when element is added to page
  connectedCallback() {
    this.init();

    // set up resize listener for responsive mode
    if (this.getAttribute("responsive") === "true") {
      this.boundResizeHandler = this.debouncedResize.bind(this);
      window.addEventListener("resize", this.boundResizeHandler);
    }
  }

  // called when element is removed from page
  // clean up listeners
  disconnectedCallback() {
    if (this.getAttribute("responsive") === "true" && this.boundResizeHandler) {
      window.removeEventListener("resize", this.boundResizeHandler);
    }
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
  }

  // attributes we watch for changes
  // attributes we watch for changes
  static get observedAttributes() {
    return [
      "type", // shape: squircle, circle, or pill
      "width", // fixed width in pixels
      "height", // fixed height in pixels
      "radius", // fixed border radius in pixels
      "radius-percent", // responsive border radius as % of smallest dimension
      "surface-type", // math curve: convex_squircle, convex_circle, concave, lip
      "bezel-width", // fixed bezel width in pixels
      "bezel-width-percent", // responsive bezel as % of smallest dimension
      "glass-thickness", // depth of glass for refraction calculation
      "refraction-scale", // intensity of refraction effect
      "specular-opacity", // brightness of rim highlight
      "blur", // amount of background blur
      "fallback-blur", // blur for non-chromium browsers
      "responsive", // enable viewport-based sizing
      "vw-width", // width as % of viewport width
      "vh-height", // height as % of viewport height
      "force-fallback", // force fallback blur mode (for testing)
      "font-size", // fixed font size in px
      "font-size-percent", // font size as % of smallest dimension (responsive mode)
    ];
  }

  // called when an observed attribute changes
  attributeChangedCallback(name, oldValue, newValue) {
    // ignore if value didnt actually change or if not initialized yet
    if (oldValue === newValue || !this.CONFIG.isInitialized) {
      return;
    }

    // these attributes require full reinit (dimensions/shape changed)
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

    // other attributes: just update config and refresh filter
    const configKey = name.replace(/-(\w)/g, (_, c) => c.toUpperCase()); // kebab-case to camelCase
    this.CONFIG[configKey] = parseFloat(newValue) || newValue;

    // update css variable for fallback blur
    if (name === "fallback-blur") {
      this.glassButton.style.setProperty(
        "--fallback-blur",
        `${this.CONFIG.fallbackBlurRadius}px`,
      );
    }

    // refresh svg filter if not using fallback
    if (!this.glassButton.classList.contains("fallback-blur")) {
      this.updateFilter();
    }
  }

  // main initialization
  // calculates dimensions and sets up everything
  init() {
    const type = this.getAttribute("type") || "squircle";
    const isResponsive = this.getAttribute("responsive") === "true";
    let width, height, radius;
    const attrRadius = parseFloat(this.getAttribute("radius"));

    // RESPONSIVE MODE: calculate dimensions from viewport percentages
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

    // set css variable for fallback blur
    this.glassButton.style.setProperty(
      "--fallback-blur",
      `${this.CONFIG.fallbackBlurRadius}px`,
    );

    // calculate and apply responsive or fixed font size
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
      this.glassButton.style.removeProperty("--button-font-size"); // fall back to 1.8rem default
    }

    // create spring animations for interactive effects
    this.springs = {
      scale: new Spring(1, 150, 8), // button scale on press
      shadowOffsetX: new Spring(0, 500, 40), // shadow x position
      shadowOffsetY: new Spring(4, 500, 40), // shadow y position
      shadowBlur: new Spring(12, 500, 40), // shadow blur radius
      shadowAlpha: new Spring(0.15, 500, 40), // shadow opacity
      refractionBoost: new Spring(1, 100, 5), // refraction intensity boost on hover
      specularAngle: new Spring(Math.PI / 3, 300, 30), // specular highlight rotation (starts at 60 degrees)
    };

    // detect browser support and set up filters
    this.detectBackdropFilterSupport();
    if (!this.glassButton.classList.contains("fallback-blur")) {
      this.updateFilter(false);
    }

    // wire up interaction handlers
    this.initHover();
    this.initPress();

    // start the animation loop
    this.startAnimationLoop();
  }

  // detect if browser supports svg filters in backdrop-filter
  // chromium browsers support it, firefox/safari dont
  detectBackdropFilterSupport() {
    // force fallback mode if requested (useful for testing)
    if (this.getAttribute("force-fallback") === "true") {
      this.glassButton.classList.add("fallback-blur");
      if (this.glassFilterSvg) this.glassFilterSvg.remove();
      return;
    }

    // check if browser is chromium-based
    const isChromium = !!window.chrome;

    // test if backdrop-filter supports url() syntax
    const testEl = document.createElement("div");
    testEl.style.backdropFilter = "url(#test)";
    const supportsBackdropFilterUrl =
      testEl.style.backdropFilter.includes("url");

    if (isChromium && supportsBackdropFilterUrl) {
      // use svg displacement map for full refraction effect
      this.glassButton.classList.add("use-backdrop-filter");
    } else {
      // use simple blur fallback
      this.glassButton.classList.add("fallback-blur");
      if (this.glassFilterSvg) this.glassFilterSvg.remove();
    }
  }

  // regenerate the svg filter with current settings
  updateFilter(updateScale = true) {
    // get the surface curve function for this glass type
    const surfaceFn = SurfaceEquations[this.CONFIG.surfaceType];

    // step 1: calculate how light bends across the glass edge (1d curve)
    const precomputed = this.calculateDisplacementMap1D(
      this.CONFIG.glassThickness,
      this.CONFIG.bezelWidth,
      surfaceFn,
      this.CONFIG.refractiveIndex,
    );

    // find the maximum displacement for scaling
    this.CONFIG.maximumDisplacement = Math.max(...precomputed.map(Math.abs));

    // step 2: apply the 1d curve across the 2d button shape
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

    // step 3: calculate the bright rim highlight effect
    const specularData = this.calculateSpecularHighlight(
      this.CONFIG.objectWidth,
      this.CONFIG.objectHeight,
      this.CONFIG.radius,
      this.CONFIG.bezelWidth,
    );

    // convert imagedata to base64 urls for the svg filter
    const displacementUrl = this.imageDataToDataURL(displacementData);
    const specularUrl = this.imageDataToDataURL(specularData);

    // update the svg filter elements
    this.shadowRoot
      .getElementById("displacementImage")
      .setAttribute("href", displacementUrl);
    this.shadowRoot
      .getElementById("specularImage")
      .setAttribute("href", specularUrl);

    // update displacement scale (skip this during hover animation)
    if (updateScale) {
      this.shadowRoot
        .getElementById("displacementMap")
        .setAttribute(
          "scale",
          this.CONFIG.maximumDisplacement * this.CONFIG.refractionScale,
        );
    }

    // update specular brightness and blur amount
    this.shadowRoot
      .getElementById("specularAlpha")
      .setAttribute("slope", this.CONFIG.specularOpacity);
    this.shadowRoot
      .getElementById("filterBlur")
      .setAttribute("stdDeviation", this.CONFIG.blur);
  }

  // main ani loop
  // updates spring physics every frame
  animationLoop(timestamp) {
    if (!this._lastTimestamp) this._lastTimestamp = timestamp;
    const dt = Math.min((timestamp - this._lastTimestamp) / 1000, 0.05); // cap at 50ms
    this._lastTimestamp = timestamp;

    // set spring targets based on button state
    if (this.CONFIG.isPressed) {
      // pressed: shrink slightly, move shadow down, boost refraction
      this.springs.scale.setTarget(0.98);
      this.springs.shadowOffsetY.setTarget(8);
      this.springs.shadowBlur.setTarget(16);
      this.springs.shadowAlpha.setTarget(0.25);
      this.springs.refractionBoost.setTarget(1.5);
      this.springs.specularAngle.setTarget((-Math.PI * 4) / 3);
    } else if (this.CONFIG.isHovering) {
      // hovering: grow slightly, big shadow, normal refraction, flip highlight
      this.springs.scale.setTarget(1.05);
      this.springs.shadowOffsetY.setTarget(16);
      this.springs.shadowBlur.setTarget(24);
      this.springs.shadowAlpha.setTarget(0.22);
      this.springs.refractionBoost.setTarget(1.0);
      this.springs.specularAngle.setTarget(-Math.PI / 3); // rotate to -60 degrees
    } else {
      // idle: normal size and shadow, default highlight
      this.springs.scale.setTarget(1);
      this.springs.shadowOffsetY.setTarget(4);
      this.springs.shadowBlur.setTarget(12);
      this.springs.shadowAlpha.setTarget(0.15);
      this.springs.refractionBoost.setTarget(0.8);
      this.springs.specularAngle.setTarget(Math.PI / 3); // 60 degrees
    }

    // update all springs and read their current values
    const scale = this.springs.scale.update(dt);
    const shadowOffsetX = this.springs.shadowOffsetX.update(dt);
    const shadowOffsetY = this.springs.shadowOffsetY.update(dt);
    const shadowBlur = this.springs.shadowBlur.update(dt);
    const shadowAlpha = this.springs.shadowAlpha.update(dt);
    const refractionBoost = this.springs.refractionBoost.update(dt);
    const specularAngleRaw = this.springs.specularAngle.update(dt);

    // normalize angle to -π to π range for calculations
    // (spring might be > 2π when rotating the long way)
    let specularAngle = specularAngleRaw % (Math.PI * 2);
    if (specularAngle > Math.PI) specularAngle -= Math.PI * 2;
    if (specularAngle < -Math.PI) specularAngle += Math.PI * 2;

    // apply scale and shadow to button
    // round scale to 4 decimal places to prevent sub-pixel jitter
    const roundedScale = Math.round(scale * 10000) / 10000;
    this.glassButton.style.transform = `scale(${roundedScale})`;
    this.glassButton.style.boxShadow = `${shadowOffsetX}px ${shadowOffsetY}px ${shadowBlur}px rgba(0, 0, 0, ${shadowAlpha})`;

    // update refraction intensity if using svg filter
    if (!this.glassButton.classList.contains("fallback-blur")) {
      const dynamicRefractionScale =
        this.CONFIG.refractionScale * refractionBoost;
      const newFilterScale =
        this.CONFIG.maximumDisplacement * dynamicRefractionScale;

      // only update svg if change is noticeable (optimization)
      if (Math.abs(newFilterScale - (this._lastFilterScale ?? -1)) > 0.5) {
        const displacementMap =
          this.shadowRoot.getElementById("displacementMap");
        if (displacementMap) {
          displacementMap.setAttribute("scale", newFilterScale);
        }
        this._lastFilterScale = newFilterScale;
      }

      // update specular highlight rotation if angle changed significantly
      // only regenerate if change is noticeable (optimization)
      const angleDiff = Math.abs(
        specularAngle - (this._lastSpecularAngle ?? Math.PI / 3),
      );
      if (angleDiff > 0.08) {
        // about 5 degrees
        // regenerate specular with new angle
        const specularData = this.calculateSpecularHighlight(
          this.CONFIG.objectWidth,
          this.CONFIG.objectHeight,
          this.CONFIG.radius,
          this.CONFIG.bezelWidth,
          specularAngle, // use current animated angle
        );
        const specularUrl = this.imageDataToDataURL(specularData);
        this.shadowRoot
          .getElementById("specularImage")
          .setAttribute("href", specularUrl);
        this._lastSpecularAngle = specularAngle;
      }
    }

    // check if all springs have settled
    const allSettled = Object.values(this.springs).every((s) => s.isSettled());

    // normalize specular angle once settled to prevent value accumulation
    if (allSettled && this.springs.specularAngle.value > Math.PI * 2) {
      // wrap the value back to normal range
      const normalized = this.springs.specularAngle.value % (Math.PI * 2);
      this.springs.specularAngle.value = normalized;
      this.springs.specularAngle.target = normalized;
    }

    // continue loop if still animating, otherwise stop
    if (!allSettled) {
      this.animationFrameId = requestAnimationFrame(
        this.animationLoop.bind(this),
      );
    } else {
      this.animationFrameId = null;
    }
  }

  // kick off the animation loop if not already running
  startAnimationLoop() {
    if (!this.animationFrameId) {
      this._lastTimestamp = null;
      this._lastFilterScale = null;
      this._lastSpecularAngle = null;
      this.animationFrameId = requestAnimationFrame(
        this.animationLoop.bind(this),
      );
    }
  }

  // wire up hover state
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

  // wire up press state
  initPress() {
    this.glassButton.addEventListener("mousedown", () => {
      this.CONFIG.isPressed = true;
      this.startAnimationLoop();
    });
    window.addEventListener("mouseup", () => {
      if (this.CONFIG.isPressed) {
        this.CONFIG.isPressed = false;
        this.startAnimationLoop();
      }
    });
  }

  // calculate how light bends through the glass edge (1d curve)
  // this simulates snell's law of refraction along the glass surface
  calculateDisplacementMap1D(
    glassThickness, // how thick the glass is
    bezelWidth, // width of the edge where light bends
    surfaceFn, // the curve equation (convex_squircle, etc)
    refractiveIndex, // how much glass bends light (default 1.5 for glass)
    samples = 128, // number of points to sample along the curve
  ) {
    const eta = 1 / refractiveIndex; // inverse refractive index for snell's law

    // snell's law: calculate how light ray bends entering glass
    function refract(normalX, normalY) {
      const dot = normalY;
      const k = 1 - eta * eta * (1 - dot * dot);
      if (k < 0) return null; // total internal reflection
      const kSqrt = Math.sqrt(k);
      return [
        -(eta * dot + kSqrt) * normalX,
        eta - (eta * dot + kSqrt) * normalY,
      ];
    }

    const result = [];

    // sample points along the glass edge curve
    for (let i = 0; i < samples; i++) {
      const x = i / samples; // position along curve (0 to 1)
      const y = surfaceFn(x); // height at this position

      // calculate surface normal (perpendicular to surface)
      const dx = x < 1 ? 0.0001 : -0.0001;
      const y2 = surfaceFn(Math.max(0, Math.min(1, x + dx)));
      const derivative = (y2 - y) / dx;
      const magnitude = Math.sqrt(derivative * derivative + 1);
      const normal = [-derivative / magnitude, -1 / magnitude];

      // apply snell's law to get refracted ray direction
      const refracted = refract(normal[0], normal[1]);
      if (!refracted) {
        // total internal reflection
        // no displacement
        result.push(0);
      } else {
        // calculate how far the light ray travels before exiting
        const remainingHeightOnBezel = y * bezelWidth;
        const remainingHeight = remainingHeightOnBezel + glassThickness;
        // horizontal displacement = how far ray shifted
        result.push(refracted[0] * (remainingHeight / refracted[1]));
      }
    }
    return result;
  }

  // apply the 1d displacement curve to the 2d button shape
  // this creates the actual refraction map that goes into the svg filter
  calculateDisplacementMap2D(
    canvasWidth, // size of imagedata to create
    canvasHeight,
    objectWidth, // actual button dimensions
    objectHeight,
    radius, // corner radius
    bezelWidth, // width of edge where refraction happens
    maximumDisplacement, // max displacement for normalization
    precomputedMap, // the 1d curve we calculated earlier
  ) {
    // create blank imagedata
    // default to no displacement (128, 128 = center)
    const imageData = new ImageData(canvasWidth, canvasHeight);
    for (let i = 0; i < imageData.data.length; i += 4) {
      imageData.data[i] = 128; // red channel = x displacement
      imageData.data[i + 1] = 128; // green channel = y displacement
      imageData.data[i + 2] = 0; // blue = unused
      imageData.data[i + 3] = 255; // alpha = fully opaque
    }

    // precalculate squared values for distance checks (optimization)
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

    // loop through every pixel in the button area
    for (let y1 = 0; y1 < objectHeight; y1++) {
      for (let x1 = 0; x1 < objectWidth; x1++) {
        const idx = ((objectY + y1) * canvasWidth + objectX + x1) * 4;

        // figure out which edge were on (if any)
        const isOnLeftSide = x1 < radius;
        const isOnRightSide = x1 >= objectWidth - radius;
        const isOnTopSide = y1 < radius;
        const isOnBottomSide = y1 >= objectHeight - radius;

        // calculate position relative to nearest corner
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

        // check if this pixel is in the bezel (refractive edge)
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

  // calculate the bright rim highlight effect
  // this simulates light reflecting off the glass edge at an angle
  calculateSpecularHighlight(
    objectWidth,
    objectHeight,
    radius,
    bezelWidth,
    specularAngle = Math.PI / 3, // angle of incoming light (60 degrees)
  ) {
    const imageData = new ImageData(objectWidth, objectHeight);

    // direction of the highlight (where light is coming from)
    const specularVector = [Math.cos(specularAngle), Math.sin(specularAngle)];
    const specularThickness = 1.5; // how wide the rim highlight is

    // precalculate squared distances for checking
    const radiusSquared = radius * radius;
    const radiusPlusOneSquared = (radius + 1) * (radius + 1);
    const radiusMinusSpecularSquared = Math.max(
      0,
      (radius - specularThickness) * (radius - specularThickness),
    );

    const widthBetweenRadiuses = objectWidth - radius * 2;
    const heightBetweenRadiuses = objectHeight - radius * 2;

    // loop through pixels and draw highlight where edge faces the light
    for (let y1 = 0; y1 < objectHeight; y1++) {
      for (let x1 = 0; x1 < objectWidth; x1++) {
        const idx = (y1 * objectWidth + x1) * 4;

        // figure out which corner we are in
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

  // convert imagedata to base64 data url for use in svg <feImage>
  imageDataToDataURL(imageData) {
    const canvas = document.createElement("canvas");
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    const ctx = canvas.getContext("2d");
    ctx.putImageData(imageData, 0, 0);
    return canvas.toDataURL(); // returns "data:image/png;base64,..."
  }
}

// register the custom element
customElements.define("liquid-btn", LiquidButton);
