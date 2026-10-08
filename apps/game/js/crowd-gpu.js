// The GPU instance pass (shaders/instances.wgsl) on the main thread: takes
// the tick-rate records the simulation sends when they change (js/crowd.js
// layouts, engine/src/instances.rs) and, every render frame, interpolates
// them by alpha, culls them against the camera and writes the sprite and
// rect instances plus their drawIndirect arguments. Per frame the CPU only
// writes two 32 byte uniforms and records the dispatches. js/renderer.js
// owns it; without it (or when it fails) the game draws the instances the
// simulation builds every frame (the CPU path).

import { INSTANCE_FLOATS, RECT_REC_FLOATS, SPRITE_EXTRA_FLOATS, SPRITE_REC_FLOATS, WORKGROUP } from './crowd.js';

const PARAMS_BYTES = 32;
const ARGS_BYTES = 16;
const STORAGE_BUFFERS = 5;

/** Why this device cannot run the pass, or null when it can. */
export function gpuInstanceSupport(device) {
  const l = device?.limits;
  if (!l) return 'no WebGPU device';
  if ((l.maxComputeWorkgroupSizeX ?? 0) < WORKGROUP || (l.maxComputeInvocationsPerWorkgroup ?? 0) < WORKGROUP) {
    return `compute workgroups of ${WORKGROUP} are not supported`;
  }
  if ((l.maxStorageBuffersPerShaderStage ?? 0) < STORAGE_BUFFERS) return 'too few storage buffers per compute stage';
  if ((l.maxComputeWorkgroupStorageSize ?? 0) < WORKGROUP * 4) return 'too little workgroup memory';
  return null;
}

/** Smallest power of two of at least `n` (and at least `min`). */
function capacity(n, min) {
  let c = min;
  while (c < n) c *= 2;
  return c;
}

/** One kind of record (sprites or rects): its buffers and its three dispatches. */
class Pass {
  constructor(owner, kind, recFloats) {
    this.owner = owner;
    this.kind = kind;
    this.recFloats = recFloats;
    this.count = 0;
    this.cap = 0;
    this.blockCap = 0;
    this.records = null;
    this.instances = null;
    this.blockSums = null;
    this.group = null;
    const d = owner.device;
    this.params = d.createBuffer({ label: `${kind} instance params`, size: PARAMS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.args = d.createBuffer({ label: `${kind} draw args`, size: ARGS_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST });
    this.paramData = new ArrayBuffer(PARAMS_BYTES);
    this.paramF32 = new Float32Array(this.paramData);
    this.paramU32 = new Uint32Array(this.paramData);
  }

  blocks() {
    return Math.ceil(this.count / WORKGROUP);
  }

  /** Upload this kind's records; grows the buffers (powers of two) when needed. */
  upload(data, extras) {
    const o = this.owner;
    const d = o.device;
    const count = data.length / this.recFloats;
    const blocks = Math.ceil(count / WORKGROUP);
    if (blocks > o.limits.maxComputeWorkgroupsPerDimension) throw new Error(`${count} ${this.kind} records need more workgroups than the device allows`);
    let grown = false;
    if (count > this.cap || !this.records) {
      const cap = capacity(count, 1024);
      const recBytes = cap * this.recFloats * 4;
      const outBytes = cap * INSTANCE_FLOATS * 4;
      if (Math.max(recBytes, outBytes) > o.maxBinding) throw new Error(`${count} ${this.kind} records exceed the storage buffer limit`);
      this.records?.destroy();
      this.instances?.destroy();
      this.records = d.createBuffer({ label: `${this.kind} records`, size: recBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.instances = d.createBuffer({ label: `${this.kind} instances`, size: outBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX });
      this.cap = cap;
      grown = true;
    }
    if (blocks > this.blockCap || !this.blockSums) {
      const cap = capacity(blocks, 64);
      this.blockSums?.destroy();
      this.blockSums = d.createBuffer({ label: `${this.kind} block sums`, size: cap * 4, usage: GPUBufferUsage.STORAGE });
      this.blockCap = cap;
      grown = true;
    }
    if (count > 0) d.queue.writeBuffer(this.records, 0, data.buffer, data.byteOffset, data.byteLength);
    this.count = count;
    if (grown || extras !== this.boundExtras || !this.group) {
      this.boundExtras = extras;
      this.group = d.createBindGroup({
        label: `${this.kind} instance pass`,
        layout: o.layout,
        entries: [
          { binding: 0, resource: { buffer: this.params } },
          { binding: 1, resource: { buffer: this.records } },
          { binding: 2, resource: { buffer: extras } },
          { binding: 3, resource: { buffer: this.instances } },
          { binding: 4, resource: { buffer: this.blockSums } },
          { binding: 5, resource: { buffer: this.args } },
        ],
      });
    }
  }

  /** Params for this frame: the view and alpha. */
  setFrame(alpha, view) {
    const f = this.paramF32;
    f[0] = view[0];
    f[1] = view[1];
    f[2] = view[2];
    f[3] = view[3];
    f[4] = Math.min(Math.max(alpha, 0), 1);
    this.paramU32[5] = this.count;
    this.paramU32[6] = this.blocks();
    this.paramU32[7] = 0;
    this.owner.device.queue.writeBuffer(this.params, 0, this.paramData);
  }

  encode(pass, count, write) {
    if (this.count === 0) return;
    const o = this.owner;
    pass.setBindGroup(0, o.emptyGroup);
    pass.setBindGroup(1, this.group);
    pass.setPipeline(count);
    pass.dispatchWorkgroups(this.blocks());
    pass.setPipeline(o.pipelines.scan);
    pass.dispatchWorkgroups(1);
    pass.setPipeline(write);
    pass.dispatchWorkgroups(this.blocks());
  }
}

export class GpuInstances {
  /**
   * Compile the pass. Rejects with the reason when this device cannot run it.
   * @param {GPUDevice} device
   * @param {string} code shaders/instances.wgsl with common.wgsl in front (as every shader)
   */
  static async create(device, code) {
    const reason = gpuInstanceSupport(device);
    if (reason) throw new Error(reason);
    const module = device.createShaderModule({ code, label: 'instances' });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length) throw new Error(`instances.wgsl: ${errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; ')}`);
    const storage = (type) => ({ visibility: GPUShaderStage.COMPUTE, buffer: { type } });
    const layout = device.createBindGroupLayout({
      label: 'instance pass',
      entries: [
        { binding: 0, ...storage('uniform') },
        { binding: 1, ...storage('read-only-storage') },
        { binding: 2, ...storage('read-only-storage') },
        { binding: 3, ...storage('storage') },
        { binding: 4, ...storage('storage') },
        { binding: 5, ...storage('storage') },
      ],
    });
    // Group 0 is the render pipelines' globals; the compute pass uses none of it.
    const empty = device.createBindGroupLayout({ entries: [] });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [empty, layout] });
    const names = ['sprite_count', 'sprite_write', 'rect_count', 'rect_write', 'scan'];
    const made = await Promise.all(
      names.map((entryPoint) => device.createComputePipelineAsync({ label: entryPoint, layout: pipelineLayout, compute: { module, entryPoint } })),
    );
    const pipelines = Object.fromEntries(names.map((n, i) => [n, made[i]]));
    return new GpuInstances(device, layout, device.createBindGroup({ layout: empty, entries: [] }), pipelines);
  }

  constructor(device, layout, emptyGroup, pipelines) {
    this.device = device;
    this.layout = layout;
    this.emptyGroup = emptyGroup;
    this.pipelines = pipelines;
    this.limits = device.limits;
    this.maxBinding = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
    this.gen = -1;
    this.extraCap = 0;
    this.extras = null;
    // Rect records have no extras: they bind a small placeholder.
    this.noExtras = device.createBuffer({ label: 'no extras', size: 16, usage: GPUBufferUsage.STORAGE });
    this.sprites = new Pass(this, 'sprite', SPRITE_REC_FLOATS);
    this.rects = new Pass(this, 'rect', RECT_REC_FLOATS);
  }

  /** Take a records frame (`{ gen, sprites, extras, rects }`); uploads only a new generation. Throws when it does not fit. */
  upload(records) {
    if (!records || records.gen === this.gen) return;
    const ex = records.extras;
    const exCount = ex.length / SPRITE_EXTRA_FLOATS;
    if (exCount > this.extraCap) {
      const cap = capacity(exCount, 256);
      if (cap * SPRITE_EXTRA_FLOATS * 4 > this.maxBinding) throw new Error(`${exCount} sprite extras exceed the storage buffer limit`);
      this.extras?.destroy();
      this.extras = this.device.createBuffer({ label: 'sprite extras', size: cap * SPRITE_EXTRA_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.extraCap = cap;
    }
    if (exCount > 0) this.device.queue.writeBuffer(this.extras, 0, ex.buffer, ex.byteOffset, ex.byteLength);
    this.sprites.upload(records.sprites, this.extras ?? this.noExtras);
    this.rects.upload(records.rects, this.noExtras);
    this.gen = records.gen;
  }

  /** Record this frame's compute work (before the render pass that draws it). */
  encode(encoder, alpha, view) {
    if (this.sprites.count === 0 && this.rects.count === 0) return;
    this.sprites.setFrame(alpha, view);
    this.rects.setFrame(alpha, view);
    const pass = encoder.beginComputePass({ label: 'instance pass' });
    const p = this.pipelines;
    this.sprites.encode(pass, p.sprite_count, p.sprite_write);
    this.rects.encode(pass, p.rect_count, p.rect_write);
    pass.end();
  }
}
