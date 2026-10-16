// WebGPU renderer: terrain, instanced sprites, heat shimmer, fog of war,
// weather and UI rectangles. Instance data comes from the simulation every
// frame (the CPU path), or as tick-rate records that the GPU instance pass
// (js/crowd-gpu.js) turns into instances and an indirect draw every frame
// (the GPU path). Terrain comes from a pre-rendered tile atlas
// (js/art/terrain.js) and weather particles are generated on the GPU.

import { GpuInstances } from './crowd-gpu.js';
import { GpuTimer } from './gputimer.js';
import { perfTrace } from './perfcapture.js';

const SPRITE_FLOATS = 8;
const RECT_FLOATS = 8;
const HEAT_FLOATS = 4;
// Line instances: [x0, y0, x1, y1, r, g, b, a, width] (engine/src/paths.rs LINE_FLOATS).
const LINE_FLOATS = 9;
// shaders/common.wgsl Globals: 8 floats, 16 team colours, the animation clock, weather (env, env2), art,
// and the weather particles' grid (wgrid, wcell, wphase, wfall).
export const GLOBALS_BYTES = 416;
const ANIM_OFFSET = 72;
const ENV_OFFSET = 76;
const ART_OFFSET = 84;
export const WEATHER_OFFSET = 88;
const STILL = { time: 0, enabled: false };

export const TEAM_COLORS = [
  [0.30, 0.55, 0.95], // player 1: blue
  [0.90, 0.25, 0.20], // player 2: red
  [0.95, 0.80, 0.25],
  [0.35, 0.80, 0.40],
  [0.80, 0.45, 0.95],
  [0.95, 0.55, 0.20],
  [0.40, 0.85, 0.85],
  [0.85, 0.85, 0.85],
  // Players 9 to 16 (missions with more players than a lobby has: js/main.js applyMissionColors).
  [0.55, 0.35, 0.20],
  [0.95, 0.60, 0.75],
  [0.55, 0.65, 0.30],
  [0.30, 0.35, 0.70],
  [0.70, 0.20, 0.45],
  [0.95, 0.95, 0.55],
  [0.25, 0.55, 0.50],
  [0.50, 0.50, 0.50],
];
/** Colours a lobby offers: the first eight. */
export const LOBBY_COLOR_COUNT = 8;
/** The lobby colours as they start (TEAM_COLORS is reordered and recoloured per game, js/main.js). */
export const TEAM_PALETTE = Object.freeze(TEAM_COLORS.slice(0, LOBBY_COLOR_COUNT).map((c) => Object.freeze(c.slice())));
/** Team colour of the neutral player (civilian buildings and the like, js/main.js). */
export const NEUTRAL_COLOR = [0.78, 0.72, 0.6];

async function loadShader(name, common) {
  const res = await fetch(`shaders/${name}.wgsl`);
  if (!res.ok) throw new Error(`failed to load shader ${name}`);
  return common + '\n' + (await res.text());
}

/**
 * The Globals uniform of every shader (shaders/common.wgsl), as floats.
 * `zoom` is in device px per world px; `fx` the weather's uniforms
 * (js/weather-fx.js WeatherFx.uniforms), or null for clear skies.
 */
export function packGlobals({ width, height, camera, zoom, time, mapW, mapH, anim = STILL, fx = null, terrainFlags = 0 }) {
  const g = new Float32Array(GLOBALS_BYTES / 4);
  g.set([width, height, camera.x, camera.y, zoom, time, mapW, mapH], 0);
  TEAM_COLORS.forEach((c, i) => g.set([c[0], c[1], c[2], 1], 8 + i * 4));
  g.set([anim.time, anim.enabled ? 1 : 0, 0, 0], ANIM_OFFSET);
  g.set(fx?.env ?? [0, 0, 0, 0], ENV_OFFSET);
  g.set(fx?.env2 ?? [0, 0, 0, 1], ENV_OFFSET + 4);
  g.set([terrainFlags, 0, 0, 0], ART_OFFSET);
  g.set(fx?.wgrid ?? [0, 0, 0, 0], WEATHER_OFFSET);
  g.set(fx?.wcell ?? [1, 1, 0, 1], WEATHER_OFFSET + 4);
  g.set(fx?.wphase ?? [0, 0, 0, 0], WEATHER_OFFSET + 8);
  g.set(fx?.wfall ?? [0, 0, 0, 0], WEATHER_OFFSET + 12);
  return g;
}

export class Renderer {
  static async create(canvas) {
    if (!navigator.gpu) throw new Error('WebGPU is not available in this browser.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter found.');
    // Timestamp queries time the render pass for the performance capture (js/gputimer.js).
    const features = adapter.features?.has?.('timestamp-query') ? ['timestamp-query'] : [];
    let device;
    try {
      device = await adapter.requestDevice({ requiredFeatures: features });
    } catch {
      device = await adapter.requestDevice();
    }
    const r = new Renderer(canvas, device);
    r.adapter = adapter;
    await r.init();
    return r;
  }

  constructor(canvas, device) {
    this.canvas = canvas;
    this.device = device;
    this.context = canvas.getContext('webgpu');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device, format: this.format, alphaMode: 'opaque' });
    this.spriteCapacity = 0;
    this.rectCapacity = 0;
    this.lineCapacity = 0;
    this.mapW = 0;
    this.mapH = 0;
    // Terrain art flags (shaders/common.wgsl Globals.art.x, js/content/terrain.js).
    this.terrainFlags = 0;
    /** Largest texture side this device takes (atlases must fit). */
    this.maxTextureSize = device.limits?.maxTextureDimension2D ?? 8192;
    // Canvas pixels per CSS pixel; js/main.js replaces it with the player's settings.
    this.pixelRatio = () => Math.min(window.devicePixelRatio || 1, 2);
    device.lost.then((info) => {
      console.error('WebGPU device lost:', info.message);
      this.timer.disable(`device lost: ${info.message}`);
    });
    /** The adapter the device came from (Renderer.create), for gpuInfo(). */
    this.adapter = null;
    /** GPU frame timing for the performance capture; `measure` is set for the frames it times. */
    this.timer = new GpuTimer(device);
    this.measure = null;
    /** Bytes written to textures and buffers since the game loop last took them (takeUploadBytes). */
    this.uploadBytes = 0;
  }

  /** The GPU and its limits, for the performance capture (no identifiers beyond what the browser reports as adapter info). */
  gpuInfo() {
    const info = this.adapter?.info ?? null;
    return {
      vendor: info?.vendor ?? null,
      architecture: info?.architecture ?? null,
      device: info?.device ?? null,
      description: info?.description ?? null,
      fallbackAdapter: this.adapter?.isFallbackAdapter ?? info?.isFallbackAdapter ?? null,
      timestamps: this.timer.timestamps,
      timestampError: this.timer.failed,
      maxTextureSize: this.maxTextureSize,
      format: this.format,
      instances: this.instances ? 'available' : this.instancesReason,
    };
  }

  /** Upload bytes since the last call (js/main.js, per frame for the capture). */
  takeUploadBytes() {
    const n = this.uploadBytes;
    this.uploadBytes = 0;
    return n;
  }

  async init() {
    const d = this.device;
    const commonRes = await fetch('shaders/common.wgsl');
    const common = await commonRes.text();
    const [terrainSrc, spriteSrc, fogSrc, rectSrc, lineSrc, weatherSrc, skySrc, heatSrc] = await Promise.all(
      ['terrain', 'sprite', 'fog', 'rect', 'line', 'weather', 'sky', 'heat'].map((n) => loadShader(n, common)),
    );

    this.globals = d.createBuffer({ size: GLOBALS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.globalsLayout = d.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
    });
    this.globalsGroup = d.createBindGroup({ layout: this.globalsLayout, entries: [{ binding: 0, resource: { buffer: this.globals } }] });

    const blend = {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };

    // Terrain
    this.terrainLayout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    this.terrainPipeline = this.pipeline(terrainSrc, this.terrainLayout, [], null, 'terrain');

    // Fog
    this.fogLayout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    this.fogPipeline = this.pipeline(fogSrc, this.fogLayout, [], blend, 'fog');
    this.linearSampler = d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    // Pixel art (original graphics, texture packs) stays crisp when zoomed.
    this.nearestSampler = d.createSampler({ magFilter: 'nearest', minFilter: 'nearest', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });

    // Sprites
    this.spriteLayout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    const instance = (stride) => ({
      arrayStride: stride,
      stepMode: 'instance',
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x4' },
        { shaderLocation: 1, offset: 16, format: 'float32x4' },
      ],
    });
    this.spritePipeline = this.pipeline(spriteSrc, this.spriteLayout, [instance(SPRITE_FLOATS * 4)], blend, 'sprites');

    // Rects (no extra bindings)
    this.rectLayout = d.createBindGroupLayout({ entries: [] });
    this.rectPipeline = this.pipeline(rectSrc, this.rectLayout, [instance(RECT_FLOATS * 4)], blend, 'rects');
    this.rectGroup = d.createBindGroup({ layout: this.rectLayout, entries: [] });

    // Weather: GPU particles and the sky overlay (no bindings beyond the globals).
    this.weatherPipeline = this.pipeline(weatherSrc, this.rectLayout, [], blend, 'weather');
    this.skyPipeline = this.pipeline(skySrc, this.rectLayout, [], blend, 'sky');
    // Heat shimmer: one instance per hot vehicle (Game.build_heat_fx).
    const heatInstance = { arrayStride: HEAT_FLOATS * 4, stepMode: 'instance', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] };
    this.heatPipeline = this.pipeline(heatSrc, this.rectLayout, [heatInstance], blend, 'heat');
    this.heatCapacity = 0;
    // Lines (unit paths, rally and target lines, range circles): the rects' bindings, a width per instance.
    const lineInstance = {
      arrayStride: LINE_FLOATS * 4,
      stepMode: 'instance',
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x4' },
        { shaderLocation: 1, offset: 16, format: 'float32x4' },
        { shaderLocation: 2, offset: 32, format: 'float32' },
      ],
    };
    this.linePipeline = this.pipeline(lineSrc, this.rectLayout, [lineInstance], blend, 'lines');

    // GPU instance pass: optional, the CPU path draws without it.
    this.instances = null;
    this.instancesReason = null;
    try {
      this.instances = await GpuInstances.create(d, await loadShader('instances', common));
    } catch (err) {
      this.instancesReason = String(err?.message ?? err);
      console.warn('GPU instance pass unavailable, using the CPU path:', this.instancesReason);
    }
  }

  /** Stop using the GPU instance pass (it failed); the CPU path takes over. */
  disableInstances(reason) {
    this.instances = null;
    this.instancesReason = reason;
    console.warn('GPU instance pass disabled, using the CPU path:', reason);
  }

  pipeline(code, layout, buffers, blend, label) {
    const d = this.device;
    const module = d.createShaderModule({ code, label });
    module.getCompilationInfo().then((info) => {
      for (const m of info.messages) {
        if (m.type === 'error') console.error(`[${label}] ${m.lineNum}:${m.linePos} ${m.message}`);
      }
    });
    return d.createRenderPipeline({
      label,
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.globalsLayout, layout] }),
      vertex: { module, entryPoint: 'vs', buffers },
      fragment: { module, entryPoint: 'fs', targets: [{ format: this.format, blend: blend ?? undefined }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  /**
   * Upload the sprite atlas (colour + team mask canvases) and frame table
   * (js/sprites.js buildAtlas, js/content/atlas.js). `atlas.filter` is
   * 'nearest' for pixel art, 'linear' (default) for WebRA's own art.
   */
  setAtlas(atlas) {
    perfTrace.span('upload.sprites', () => this.uploadAtlas(atlas), () => ({ width: atlas.color.width, height: atlas.color.height }));
  }

  uploadAtlas(atlas) {
    const d = this.device;
    this.atlasTex?.destroy();
    this.maskTex?.destroy();
    this.frames?.destroy();
    const make = (canvas) => {
      const tex = d.createTexture({
        size: [canvas.width, canvas.height],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      d.queue.copyExternalImageToTexture({ source: canvas }, { texture: tex, premultipliedAlpha: false }, [canvas.width, canvas.height]);
      return tex;
    };
    this.atlasTex = make(atlas.color);
    this.maskTex = make(atlas.mask);
    this.frames = d.createBuffer({ size: atlas.frames.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(this.frames, 0, atlas.frames);
    this.uploadBytes += (atlas.color.width * atlas.color.height + atlas.mask.width * atlas.mask.height) * 4 + atlas.frames.byteLength;
    const filter = atlas.filter === 'nearest' ? 'nearest' : 'linear';
    const sampler = d.createSampler({ magFilter: filter, minFilter: filter });
    this.spriteGroup = d.createBindGroup({
      layout: this.spriteLayout,
      entries: [
        { binding: 0, resource: this.atlasTex.createView() },
        { binding: 1, resource: this.maskTex.createView() },
        { binding: 2, resource: sampler },
        { binding: 3, resource: { buffer: this.frames } },
      ],
    });
  }

  setMapSize(w, h) {
    const d = this.device;
    this.mapW = w;
    this.mapH = h;
    // The previous game's map textures (a restart in place keeps the renderer).
    this.terrainTex?.destroy();
    this.cellTex?.destroy();
    this.fogTex?.destroy();
    this.terrainTex = d.createTexture({ size: [w, h], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.cellTex = d.createTexture({ size: [w, h], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.fogTex = d.createTexture({ size: [w, h], format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.terrainGroup = null;
    this.bindTerrain();
    this.fogGroup = d.createBindGroup({
      layout: this.fogLayout,
      entries: [
        { binding: 0, resource: this.fogTex.createView() },
        { binding: 1, resource: this.linearSampler },
      ],
    });
  }

  /**
   * The game is going without the page (a restart in place, the next
   * mission): its atlases, map textures and frame table are freed on the GPU.
   * The next game uploads its own before it draws (setAtlas, setMapSize,
   * setTerrainAtlas); the pipelines and the per-frame buffers stay.
   */
  releaseGame() {
    for (const key of ['atlasTex', 'maskTex', 'frames', 'terrainTex', 'cellTex', 'fogTex', 'terrainAtlasTex']) {
      this[key]?.destroy();
      this[key] = null;
    }
    this.spriteGroup = null;
    this.terrainGroup = null;
    this.fogGroup = null;
    this.measure = null;
  }

  /**
   * The terrain tile atlas: the biome's WebRA tiles (js/art/terrain.js
   * buildTerrainAtlas) or tile terrain (js/content/terrain.js, with `flags`
   * for the shader and `filter: 'nearest'`).
   */
  setTerrainAtlas(atlas) {
    perfTrace.span('upload.terrain-atlas', () => this.uploadTerrainAtlas(atlas), () => ({ width: atlas.width, height: atlas.height }));
  }

  uploadTerrainAtlas(atlas) {
    const d = this.device;
    this.terrainFlags = atlas.flags ?? 0;
    this.terrainSampler = atlas.filter === 'nearest' ? this.nearestSampler : this.linearSampler;
    this.terrainAtlasTex?.destroy();
    this.terrainAtlasTex = d.createTexture({ size: [atlas.width, atlas.height], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    d.queue.writeTexture({ texture: this.terrainAtlasTex }, atlas.data, { bytesPerRow: atlas.width * 4 }, [atlas.width, atlas.height]);
    this.uploadBytes += atlas.width * atlas.height * 4;
    this.bindTerrain();
  }

  bindTerrain() {
    if (!this.terrainTex || !this.terrainAtlasTex) return;
    this.terrainGroup = this.device.createBindGroup({
      layout: this.terrainLayout,
      entries: [
        { binding: 0, resource: this.terrainTex.createView() },
        { binding: 1, resource: this.cellTex.createView() },
        { binding: 2, resource: this.terrainAtlasTex.createView() },
        { binding: 3, resource: this.terrainSampler ?? this.linearSampler },
      ],
    });
  }

  /** Per-cell tile layer (js/art/terrain.js cellTiles), RGBA per cell. */
  uploadCells(bytes) {
    this.device.queue.writeTexture({ texture: this.cellTex }, bytes, { bytesPerRow: this.mapW * 4 }, [this.mapW, this.mapH]);
    this.uploadBytes += bytes.byteLength;
  }

  uploadTerrain(bytes) {
    this.device.queue.writeTexture({ texture: this.terrainTex }, bytes, { bytesPerRow: this.mapW * 4 }, [this.mapW, this.mapH]);
    this.uploadBytes += bytes.byteLength;
  }

  uploadFog(bytes) {
    this.device.queue.writeTexture({ texture: this.fogTex }, bytes, { bytesPerRow: this.mapW }, [this.mapW, this.mapH]);
    this.uploadBytes += bytes.byteLength;
  }

  ensureBuffer(kind, count, floats) {
    const capKey = kind + 'Capacity';
    if (count <= this[capKey]) return;
    let cap = Math.max(1024, this[capKey]);
    while (cap < count) cap *= 2;
    this[kind + 'Buffer']?.destroy();
    this[kind + 'Buffer'] = this.device.createBuffer({ size: cap * floats * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this[capKey] = cap;
  }

  resize() {
    const dpr = this.pixelRatio();
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    return dpr;
  }

  /**
   * @param camera {x, y, zoom} zoom in CSS pixels per world pixel
   * @param sprites Float32Array of sprite instances
   * @param rects Float32Array of rect instances (sim rects followed by UI rects)
   * @param anim {time, enabled} render clock of sprite animations (js/anim.js); still frames by default
   * @param lines optional Float32Array of line instances (rally lines, unit paths), drawn over the fog and under the rects
   * @param gpu optional `{ records, alpha, view }`: draw the simulation's sprites and rects from tick-rate
   *   records with the GPU instance pass (`sprites` is then ignored and `rects` holds the UI rects only,
   *   drawn after the simulation's); `view` is the visible world rectangle [x0, y0, x1, y1]
   * @param fx weather: `{ env, env2, wgrid, wcell, wphase, wfall }` (js/weather-fx.js uniforms) and heat
   *   shimmer instances `heat` (Float32Array, 4 floats each) / `heatCount`
   */
  draw(camera, time, sprites, spriteCount, rects, rectCount, anim = STILL, lines = null, lineCount = 0, gpu = null, fx = null) {
    const d = this.device;
    const dpr = this.resize();
    const zoom = camera.zoom * dpr;
    const g = packGlobals({ width: this.canvas.width, height: this.canvas.height, camera, zoom, time, mapW: this.mapW, mapH: this.mapH, anim, fx, terrainFlags: this.terrainFlags });
    d.queue.writeBuffer(this.globals, 0, g);
    const particles = Math.floor(fx?.env2?.[2] ?? 0);
    const heatCount = fx?.heatCount ?? 0;
    if (heatCount > 0) {
      if (heatCount > this.heatCapacity) {
        this.heatBuffer?.destroy();
        this.heatCapacity = Math.max(64, 2 ** Math.ceil(Math.log2(heatCount)));
        this.heatBuffer = d.createBuffer({ size: this.heatCapacity * HEAT_FLOATS * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      }
      d.queue.writeBuffer(this.heatBuffer, 0, fx.heat, 0, heatCount * HEAT_FLOATS);
      this.uploadBytes += heatCount * HEAT_FLOATS * 4;
    }

    let inst = null;
    if (gpu && this.instances) {
      try {
        const r = gpu.records;
        if (r && r.gen !== this.instances.gen) this.uploadBytes += r.sprites.byteLength + r.extras.byteLength + r.rects.byteLength;
        this.instances.upload(r);
        inst = this.instances;
      } catch (err) {
        this.disableInstances(String(err?.message ?? err));
      }
    }
    if (gpu) spriteCount = 0;
    if (spriteCount > 0) {
      this.ensureBuffer('sprite', spriteCount, SPRITE_FLOATS);
      d.queue.writeBuffer(this.spriteBuffer, 0, sprites, 0, spriteCount * SPRITE_FLOATS);
    }
    if (rectCount > 0) {
      this.ensureBuffer('rect', rectCount, RECT_FLOATS);
      d.queue.writeBuffer(this.rectBuffer, 0, rects, 0, rectCount * RECT_FLOATS);
    }
    if (lineCount > 0) {
      this.ensureBuffer('line', lineCount, LINE_FLOATS);
      d.queue.writeBuffer(this.lineBuffer, 0, lines, 0, lineCount * LINE_FLOATS);
    }
    this.uploadBytes += GLOBALS_BYTES + (spriteCount * SPRITE_FLOATS + rectCount * RECT_FLOATS + lineCount * LINE_FLOATS) * 4;

    const enc = d.createCommandEncoder();
    // Interpolate, cull and compact the records for this frame.
    inst?.encode(enc, gpu.alpha, gpu.view);
    // The performance capture times this frame (js/gputimer.js).
    const timing = this.measure ? this.timer.begin(this.measure) : null;
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
      ...timing?.pass,
    });
    pass.setBindGroup(0, this.globalsGroup);

    if (this.terrainGroup) {
      pass.setPipeline(this.terrainPipeline);
      pass.setBindGroup(1, this.terrainGroup);
      pass.draw(3);
    }

    if (spriteCount > 0) {
      pass.setPipeline(this.spritePipeline);
      pass.setBindGroup(1, this.spriteGroup);
      pass.setVertexBuffer(0, this.spriteBuffer);
      pass.draw(6, spriteCount);
    } else if (inst && inst.sprites.count > 0) {
      pass.setPipeline(this.spritePipeline);
      pass.setBindGroup(1, this.spriteGroup);
      pass.setVertexBuffer(0, inst.sprites.instances);
      pass.drawIndirect(inst.sprites.args, 0);
    }

    if (heatCount > 0) {
      pass.setPipeline(this.heatPipeline);
      pass.setBindGroup(1, this.rectGroup);
      pass.setVertexBuffer(0, this.heatBuffer);
      pass.draw(6, heatCount);
    }

    pass.setPipeline(this.fogPipeline);
    pass.setBindGroup(1, this.fogGroup);
    pass.draw(3);

    if (lineCount > 0) {
      pass.setPipeline(this.linePipeline);
      pass.setBindGroup(1, this.rectGroup);
      pass.setVertexBuffer(0, this.lineBuffer);
      pass.draw(6, lineCount);
    }

    if (particles > 0) {
      pass.setPipeline(this.weatherPipeline);
      pass.setBindGroup(1, this.rectGroup);
      pass.draw(6, particles);
    }
    if (fx && (fx.env[2] > 0 || fx.env[3] > 0)) {
      pass.setPipeline(this.skyPipeline);
      pass.setBindGroup(1, this.rectGroup);
      pass.draw(3);
    }

    if (inst && inst.rects.count > 0) {
      // The simulation's rects, then the UI's (as on the CPU path, where they share one buffer).
      pass.setPipeline(this.rectPipeline);
      pass.setBindGroup(1, this.rectGroup);
      pass.setVertexBuffer(0, inst.rects.instances);
      pass.drawIndirect(inst.rects.args, 0);
    }
    if (rectCount > 0) {
      pass.setPipeline(this.rectPipeline);
      pass.setBindGroup(1, this.rectGroup);
      pass.setVertexBuffer(0, this.rectBuffer);
      pass.draw(6, rectCount);
    }
    pass.end();
    timing?.resolve(enc);
    d.queue.submit([enc.finish()]);
    timing?.submitted();
  }
}
