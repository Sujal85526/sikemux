// The device screens' backdrop, drawn with the phone's own shaders and presets
// from mobile/app/src/ui/Backdrop.tsx, once, then laid behind every device screen.
import { ditheringFragmentShader, getShaderColorFromString, imageDitheringFragmentShader } from '@paper-design/shaders';

import { vertexShaderSource } from '../app/src/ui/vertexShader.generated';

const WIDTH = 390;
const HEIGHT = 844;
const RATIO = 2;
const INK = '#e7e5ef';
const SHADER_DOT = '#19191e';
const STILL_MS = 2500;
const LONGEST_EDGE = 1280;
const STORE = 'sikemux-design-backdrop';

function preset(picture) {
  const sizing = { u_originX: 0.5, u_originY: 0.5, u_worldWidth: 0, u_worldHeight: 0, u_rotation: 0, u_offsetX: 0, u_offsetY: 0 };
  const clear = [0, 0, 0, 0];
  if (picture) {
    const ink = getShaderColorFromString(INK);
    return {
      fragment: imageDitheringFragmentShader,
      band: 0.6,
      strength: 0.38,
      uniforms: {
        ...sizing,
        u_colorBack: clear,
        u_colorFront: ink,
        u_colorHighlight: ink,
        u_originalColors: true,
        u_inverted: false,
        u_type: 4,
        u_pxSize: 2,
        u_colorSteps: 4,
        u_fit: 2,
        u_scale: 1,
        u_imageAspectRatio: picture.naturalWidth / picture.naturalHeight,
        u_image: 0,
        u_time: 0,
      },
    };
  }
  return {
    fragment: ditheringFragmentShader,
    band: 0.5,
    strength: 0.85,
    uniforms: {
      ...sizing,
      u_colorBack: clear,
      u_colorFront: getShaderColorFromString(SHADER_DOT),
      u_shape: 1,
      u_type: 4,
      u_pxSize: 3,
      u_fit: 0,
      u_scale: 2.4,
      u_time: (STILL_MS * 0.5) / 1000,
    },
  };
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
  return shader;
}

function render(picture) {
  const { fragment, band, strength, uniforms } = preset(picture);
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH * RATIO;
  canvas.height = Math.round(HEIGHT * band) * RATIO;
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true });
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertexShaderSource));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  const position = gl.getAttribLocation(program, 'a_position');
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  gl.viewport(0, 0, canvas.width, canvas.height);
  const all = { ...uniforms, u_resolution: [canvas.width, canvas.height], u_pixelRatio: RATIO };
  for (const [name, value] of Object.entries(all)) {
    const location = gl.getUniformLocation(program, name);
    if (!location) continue;
    if (typeof value === 'boolean') gl.uniform1i(location, value ? 1 : 0);
    else if (name === 'u_image') gl.uniform1i(location, value);
    else if (typeof value === 'number') gl.uniform1f(location, value);
    else if (value.length === 2) gl.uniform2fv(location, value);
    else gl.uniform4fv(location, value);
  }
  if (picture) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, picture);
  }
  gl.clearColor(0, 0, 0, 0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  const root = document.documentElement.style;
  root.setProperty('--backdrop-art', `url("${canvas.toDataURL('image/png')}")`);
  root.setProperty('--backdrop-band', `${band * 100}%`);
  root.setProperty('--backdrop-strength', String(strength));
  gl.getExtension('WEBGL_lose_context')?.loseContext();
}

function loadImage(src) {
  return new Promise((done, fail) => {
    const image = new Image();
    image.onload = () => done(image);
    image.onerror = fail;
    image.src = src;
  });
}

/** Shrunk to what the Mac sends a phone: its longest edge 1280, as a JPEG. */
async function shrink(file) {
  const image = await loadImage(URL.createObjectURL(file));
  const scale = Math.min(1, LONGEST_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = Math.round(image.naturalHeight * scale);
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.82);
}

function saved() {
  try {
    return JSON.parse(localStorage.getItem(STORE)) ?? { mode: 'grain' };
  } catch {
    return { mode: 'grain' };
  }
}

async function apply(state) {
  localStorage.setItem(STORE, JSON.stringify(state));
  const mode = state.mode === 'picture' && !state.picture ? 'grain' : state.mode;
  document.body.classList.toggle('has-backdrop', mode !== 'none');
  document.querySelectorAll('.backdrop-pick [data-mode]').forEach((button) => button.classList.toggle('on', button.dataset.mode === mode));
  if (mode === 'none') return;
  render(mode === 'picture' ? await loadImage(state.picture) : undefined);
}

const pick = document.querySelector('.backdrop-pick');
const file = pick.querySelector('input[type=file]');
pick.querySelectorAll('[data-mode]').forEach((button) =>
  button.addEventListener('click', () => {
    const state = saved();
    if (button.dataset.mode === 'picture' && !state.picture) file.click();
    else apply({ ...state, mode: button.dataset.mode });
  }),
);
pick.querySelector('.choose').addEventListener('click', () => file.click());
file.addEventListener('change', async () => {
  if (!file.files?.[0]) return;
  apply({ mode: 'picture', picture: await shrink(file.files[0]) });
});
apply(saved());
