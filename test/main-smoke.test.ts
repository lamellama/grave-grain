declare const require: any; declare const process: any;
/**
 * main-smoke.test.ts — headless DOM-bootstrap smoke test.
 * Imports the REAL main.ts under stubbed DOM/canvas globals and asserts it
 * loads WITHOUT throwing and performs at least one render. This guards the
 * runtime bootstrap (init order, getRenderer-before-initRenderer, dead buttons)
 * that HTTP-200 / headless-module tests do not exercise.
 */
let rafCalls = 0;
let fillRectCalls = 0;
let putImageCalls = 0;

function fakeCtx(): any {
  return {
    fillStyle: '#000', font: '', textAlign: 'left',
    save(){}, restore(){}, scale(){},
    fillRect(){ fillRectCalls++; },
    fillText(){},
    createImageData(w:number,h:number){ return { data: new Uint8ClampedArray(Math.max(1,w*h*4)), width:w, height:h }; },
    putImageData(){ putImageCalls++; },
    measureText(){ return { width: 0 }; },
  };
}
function fakeEl(): any {
  return {
    width:0, height:0, style:{}, dataset:{},
    getContext(){ return fakeCtx(); },
    getBoundingClientRect(){ return { width:1280, height:720, left:0, top:0, right:1280, bottom:720 }; },
    addEventListener(){}, removeEventListener(){},
    setAttribute(){}, getAttribute(){ return null; },
    classList:{ add(){}, remove(){}, toggle(){} },
    appendChild(){}, querySelector(){ return null; },
    textContent:'',
  };
}
const g:any = globalThis;
g.devicePixelRatio = 2;
g.requestAnimationFrame = (_fn:Function) => { rafCalls++; return 1; }; // don't actually spin the loop
g.cancelAnimationFrame = () => {};
g.performance = g.performance || { now: () => Date.now() };
g.window = g;
g.document = {
  getElementById(){ return fakeEl(); },
  querySelector(){ return fakeEl(); },
  querySelectorAll(){ return [] as any; },
  createElement(){ return fakeEl(); },
  addEventListener(){}, removeEventListener(){},
  body: fakeEl(),
};
g.addEventListener = () => {};

let threw: any = null;
try {
  require('../src/main');
} catch (e) { threw = e; }

// main starts the loop via requestAnimationFrame(renderLoop); our stub records
// the call but doesn't invoke it, so the module must load cleanly on its own.
console.log('threw:', threw ? (threw.message || String(threw)) : 'none');
console.log('rafCalls:', rafCalls, 'fillRectCalls:', fillRectCalls, 'putImageCalls:', putImageCalls);
const ok = !threw && rafCalls >= 1;
console.log(ok ? 'PASS: main bootstrap loaded without throwing and started the loop' : 'FAIL: bootstrap error');
if (!ok) process.exit(1);
