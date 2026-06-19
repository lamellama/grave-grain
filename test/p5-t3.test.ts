import { createSurvivor, updateSurvivor } from '../src/characters/survivor';
import { material, set } from '../src/engine/grid';
import { STONE } from '../src/engine/materials';
import { WORLD_W, NEED_MAX, WANDER_RADIUS } from '../src/config';

const BODY_W = 6;
function clearGrid(){ material.fill(0); }
function floor(row:number){ for(let x=0;x<WORLD_W;x++) set(x,row,STONE); }
function overlap(b:any):boolean{
  for(const bone of b.rig){ if(bone.destroyed) continue;
    for(const p of bone.pixels){ const wx=Math.round(b.x)+bone.offset.dx+p.dx, wy=Math.round(b.y)+bone.offset.dy+p.dy;
      if(material[wy*WORLD_W+wx]===STONE) return true; } }
  return false; }

// 1. needs deplete (idle)
clearGrid(); floor(150);
const idle = createSurvivor(200,149); idle.behaviour='consuming';
const h0 = idle.needs.hunger, t0 = idle.needs.thirst;
for(let i=0;i<600;i++) updateSurvivor(idle);
console.log('R1 idle hunger drop:', (h0-idle.needs.hunger).toFixed(3), 'thirst drop:', (t0-idle.needs.thirst).toFixed(3));
console.log('R1 PASS needs deplete + thirst faster:', (h0-idle.needs.hunger)>0 && (t0-idle.needs.thirst) > (h0-idle.needs.hunger));

// 2. wander bounded + no tunnel
clearGrid(); floor(150);
const w = createSurvivor(300,149);
let maxDist=0, tunnel=false;
for(let i=0;i<1500;i++){ updateSurvivor(w); maxDist=Math.max(maxDist,Math.abs(Math.round(w.body.x)-w.home.x)); if(overlap(w.body)) tunnel=true; }
console.log('R2 wander maxDist:', maxDist, 'radius:', WANDER_RADIUS, 'tunnel:', tunnel);
console.log('R2 PASS bounded(+body slop) & no-tunnel:', maxDist<=WANDER_RADIUS+BODY_W && !tunnel);

// 3. no resources -> dies
clearGrid(); floor(150);
const d = createSurvivor(250,149); let deathTick=-1;
for(let i=0;i<60000 && deathTick<0;i++){ updateSurvivor(d); if(!d.body.alive) deathTick=i; }
console.log('R3 death tick:', deathTick, 'cause:', d.deathCause, 'alive:', d.body.alive);
console.log('R3 PASS dies:', d.body.alive===false && !!d.deathCause);
