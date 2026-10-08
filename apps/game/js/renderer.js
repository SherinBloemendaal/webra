// WebGPU renderer: terrain, instanced sprites, fog of war and UI rectangles.
// Instance data is copied straight out of WebAssembly memory every frame.

const SPRITE_FLOATS = 8;
const RECT_FLOATS = 8;
const LINE_FLOATS = 8;
const GLOBALS_BYTES = 160;

export const TEAM_COLORS = [
  [0.30, 0.55, 0.95], // player 1: blue
  [0.90, 0.25, 0.20], // player 2: red
  [0.95, 0.80, 0.25],
  [0.35, 0.80, 0.40],
  [0.80, 0.45, 0.95],
  [0.95, 0.55, 0.20],
  [0.40, 0.85, 0.85],
  [0.85, 0.85, 0.85],
];

async function loadShader(name, common) {
  const res = await fetch(`shaders/${name}.wgsl`);
  if (!res.ok) throw new Error(`failed to load shader ${name}`);
  return common + '\n' + (await res.text());
}

export class Renderer {
  static async create(canvas) {
    if (!navigator.gpu) throw new Error('WebGPU is not available in this browser.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter found.');
    const device = await adapter.requestDevice();
    const r = new Renderer(canvas, device);
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
    device.lost.then((info) => console.error('WebGPU device lost:', info.message));
  }

  async init() {
    const d = this.device;
    const commonRes = await fetch('shaders/common.wgsl');
    const common = await commonRes.text();
    const [terrainSrc, spriteSrc, fogSrc, rectSrc, lineSrc] = await Promise.all(
      ['terrain', 'sprite', 'fog', 'rect', 'line'].map((n) => loadShader(n, common)),
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
      entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }],
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

    // Lines (unit paths): same instance layout and bindings as rects.
    this.linePipeline = this.pipeline(lineSrc, this.rectLayout, [instance(LINE_FLOATS * 4)], blend, 'lines');
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

  /** Upload the sprite atlas (colour + team mask canvases) and frame table. */
  setAtlas(atlas) {
    const d = this.device;
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
    const sampler = d.createSampler({ magFilter: 'linear', minFilter: 'linear' });
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
    this.terrainTex = d.createTexture({ size: [w, h], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.fogTex = d.createTexture({ size: [w, h], format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.terrainGroup = d.createBindGroup({ layout: this.terrainLayout, entries: [{ binding: 0, resource: this.terrainTex.createView() }] });
    this.fogGroup = d.createBindGroup({
      layout: this.fogLayout,
      entries: [
        { binding: 0, resource: this.fogTex.createView() },
        { binding: 1, resource: this.linearSampler },
      ],
    });
  }

  uploadTerrain(bytes) {
    this.device.queue.writeTexture({ texture: this.terrainTex }, bytes, { bytesPerRow: this.mapW * 4 }, [this.mapW, this.mapH]);
  }

  uploadFog(bytes) {
    this.device.queue.writeTexture({ texture: this.fogTex }, bytes, { bytesPerRow: this.mapW }, [this.mapW, this.mapH]);
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
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
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
   * @param lines optional Float32Array of line instances (unit paths), drawn under the rects
   */
  draw(camera, time, sprites, spriteCount, rects, rectCount, lines = null, lineCount = 0) {
    const d = this.device;
    const dpr = this.resize();
    const zoom = camera.zoom * dpr;
    const g = new Float32Array(GLOBALS_BYTES / 4);
    g.set([this.canvas.width, this.canvas.height, camera.x, camera.y, zoom, time, this.mapW, this.mapH], 0);
    TEAM_COLORS.forEach((c, i) => g.set([c[0], c[1], c[2], 1], 8 + i * 4));
    d.queue.writeBuffer(this.globals, 0, g);

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

    const enc = d.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    pass.setBindGroup(0, this.globalsGroup);

    pass.setPipeline(this.terrainPipeline);
    pass.setBindGroup(1, this.terrainGroup);
    pass.draw(3);

    if (spriteCount > 0) {
      pass.setPipeline(this.spritePipeline);
      pass.setBindGroup(1, this.spriteGroup);
      pass.setVertexBuffer(0, this.spriteBuffer);
      pass.draw(6, spriteCount);
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

    if (rectCount > 0) {
      pass.setPipeline(this.rectPipeline);
      pass.setBindGroup(1, this.rectGroup);
      pass.setVertexBuffer(0, this.rectBuffer);
      pass.draw(6, rectCount);
    }
    pass.end();
    d.queue.submit([enc.finish()]);
  }
}
