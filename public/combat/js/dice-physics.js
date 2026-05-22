/* ================================================================
   3D PHYSICS DICE — overlaid on battle canvas
================================================================ */
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.158.0/build/three.module.js';
import * as CANNON from 'https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js';

const UP = new THREE.Vector3(0,1,0);
const _tA=new THREE.Vector3(), _tB=new THREE.Vector3(), _tC=new THREE.Vector3();

function parseExpression(text){
  const cleaned=String(text||'').replace(/\s+/g,'').toLowerCase();
  if(!cleaned)return{dice:[{count:1,sides:20,sign:1}],mod:0};
  const parts=cleaned.match(/[+-]?[^+-]+/g)||[];
  const dice=[];let mod=0;
  for(const part of parts){
    let sign=1,token=part;
    if(token[0]==='+')token=token.slice(1);
    else if(token[0]==='-'){sign=-1;token=token.slice(1);}
    const dm=token.match(/^(\d*)d(\d+)$/);
    if(dm){
      const count=Math.min(20,parseInt(dm[1]||'1',10));
      const sides=parseInt(dm[2],10);
      if([3,4,6,8,10,12,20].includes(sides))dice.push({count,sides,sign});
      continue;
    }
    const num=parseInt(token,10);
    if(!Number.isNaN(num))mod+=sign*num;
  }
  if(!dice.length)dice.push({count:1,sides:20,sign:1});
  return{dice,mod};
}

function hashStringToSeed(str){
  let h=2166136261>>>0;
  for(let i=0;i<str.length;i++){
    h^=str.charCodeAt(i);
    h=Math.imul(h,16777619);
  }
  return h>>>0;
}
function mulberry32(seed){
  let a=seed>>>0;
  return function(){
    a|=0; a=a+0x6D2B79F5|0;
    let t=Math.imul(a^a>>>15,1|a);
    t=t+Math.imul(t^t>>>7,61|t)^t;
    return ((t^t>>>14)>>>0)/4294967296;
  };
}

function triData(geometry){
  const geo=geometry.index?geometry.toNonIndexed():geometry.clone();
  const pos=geo.attributes.position;
  const normals=[],centers=[];
  for(let i=0;i<pos.count;i+=3){
    _tA.fromBufferAttribute(pos,i);_tB.fromBufferAttribute(pos,i+1);_tC.fromBufferAttribute(pos,i+2);
    normals.push(_tB.clone().sub(_tA).cross(_tC.clone().sub(_tA)).normalize());
    centers.push(_tA.clone().add(_tB).add(_tC).multiplyScalar(1/3));
  }
  return{geo,normals,centers};
}

function uniqueVerts(geometry){
  const geo=geometry.index?geometry.toNonIndexed():geometry.clone();
  const pos=geo.attributes.position,verts=[],seen=new Set();
  for(let i=0;i<pos.count;i++){
    const x=pos.getX(i),y=pos.getY(i),z=pos.getZ(i);
    const k=`${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`;
    if(!seen.has(k)){seen.add(k);verts.push(new THREE.Vector3(x,y,z));}
  }
  return verts;
}

function orientToNormal(obj,normal){
  const z=normal.clone().normalize();
  const ref=Math.abs(z.dot(UP))>0.92?new THREE.Vector3(1,0,0):UP;
  const x=new THREE.Vector3().crossVectors(ref,z).normalize();
  const y=new THREE.Vector3().crossVectors(z,x).normalize();
  obj.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x,y,z));
}


function hexToRgb(hex){
  const h=String(hex||'').replace('#','').trim();
  const v=h.length===3 ? h.split('').map(ch=>ch+ch).join('') : h.padStart(6,'0').slice(0,6);
  return {r:parseInt(v.slice(0,2),16),g:parseInt(v.slice(2,4),16),b:parseInt(v.slice(4,6),16)};
}
function luminance(hex){
  const {r,g,b}=hexToRgb(hex);
  const srgb=[r,g,b].map(v=>{
    v/=255;
    return v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055,2.4);
  });
  return 0.2126*srgb[0]+0.7152*srgb[1]+0.0722*srgb[2];
}
function contrastRatio(a,b){
  const L1=luminance(a),L2=luminance(b);
  const hi=Math.max(L1,L2),lo=Math.min(L1,L2);
  return (hi+0.05)/(lo+0.05);
}
function pickBestContrastingColor(base, candidates, fallback, rng=Math.random){
  const good=candidates.filter(c=>contrastRatio(base,c)>=4.5);
  if(good.length)return good[Math.floor(rng()*good.length)];
  let best=fallback, bestScore=-1;
  for(const c of candidates){
    const score=contrastRatio(base,c);
    if(score>bestScore){bestScore=score;best=c;}
  }
  return best;
}
function getRandomDieColors(rng=Math.random){
  const basePalette=[
    '#ef4444', '#22c55e', '#3b82f6', '#eab308', '#a855f7', '#f97316',
    '#06b6d4', '#ec4899', '#14b8a6', '#8b5cf6', '#f43f5e', '#84cc16'
  ];
  const darkLabelPalette=['#030712','#0f172a','#111827','#1f2937','#312e81','#3b0764','#4a044e','#164e63'];
  const lightLabelPalette=['#f8fafc','#fff7ed','#fffbeb','#fefce8','#ecfeff','#fdf2f8','#f5f3ff','#ffffff'];
  const base=basePalette[Math.floor(rng()*basePalette.length)];
  const baseLum=luminance(base);
  const labelCandidates=baseLum>0.45 ? darkLabelPalette : lightLabelPalette;
  const numberColor=pickBestContrastingColor(base,labelCandidates,baseLum>0.45 ? '#111827' : '#f8fafc',rng);
  const glowColor=pickBestContrastingColor(numberColor, baseLum>0.45 ? lightLabelPalette : darkLabelPalette, numberColor,rng);
  return {diceColor:base, numberColor, glowColor};
}

function getFixedDieColors(base,rng=Math.random){
  const darkLabelPalette=['#030712','#0f172a','#111827','#1f2937','#312e81','#3b0764','#4a044e','#164e63'];
  const lightLabelPalette=['#f8fafc','#fff7ed','#fffbeb','#fefce8','#ecfeff','#fdf2f8','#f5f3ff','#ffffff'];
  const b=String(base||'#f7f8fd');
  const baseLum=luminance(b);
  const labelCandidates=baseLum>0.45 ? darkLabelPalette : lightLabelPalette;
  const numberColor=pickBestContrastingColor(b,labelCandidates,baseLum>0.45 ? '#111827' : '#f8fafc',rng);
  const glowColor=pickBestContrastingColor(numberColor, baseLum>0.45 ? lightLabelPalette : darkLabelPalette, numberColor,rng);
  return {diceColor:b, numberColor, glowColor};
}

function makeFaceTex(label,kind,opts={}){
  const{numberColor='#111827',glowColor=numberColor}=opts;
  const c=document.createElement('canvas');c.width=1024;c.height=1024;
  const cx=c.getContext('2d');cx.clearRect(0,0,1024,1024);
  const text=String(label);
  if(kind==='pip'){
    const dot=(x,y,r=44)=>{
      cx.save();
      cx.shadowColor=glowColor;
      cx.shadowBlur=36;
      cx.shadowOffsetX=0;
      cx.shadowOffsetY=0;
      cx.fillStyle=glowColor;
      cx.beginPath();cx.arc(x,y,r,0,Math.PI*2);cx.fill();
      cx.shadowBlur=0;
      cx.fillStyle=numberColor;
      cx.beginPath();cx.arc(x,y,r,0,Math.PI*2);cx.fill();
      cx.restore();
    };
    const C=512,O=210;
    if(label===1)dot(C,C);
    if(label===2){dot(C-O,C-O);dot(C+O,C+O);}
    if(label===3){dot(C-O,C-O);dot(C,C);dot(C+O,C+O);}
    if(label===4){dot(C-O,C-O);dot(C+O,C-O);dot(C-O,C+O);dot(C+O,C+O);}
    if(label===5){dot(C-O,C-O);dot(C+O,C-O);dot(C,C);dot(C-O,C+O);dot(C+O,C+O);}
    if(label===6){dot(C-O,C-O);dot(C+O,C-O);dot(C-O,C);dot(C+O,C);dot(C-O,C+O);dot(C+O,C+O);}
  } else {
    const two=text.length>=2;
    let fs=600;
    if(kind==='d20')fs=two?360:500;
    if(kind==='d8')fs=two?390:520;
    if(kind==='d4')fs=500;
    if(kind==='d3'||kind==='d10')fs=two?390:500;
    cx.font=`900 ${fs}px Arial,Helvetica,sans-serif`;cx.textAlign='center';cx.textBaseline='middle';cx.lineJoin='round';cx.miterLimit=2;
    const X=512,Y=kind==='d4'?525:516;
    cx.save();
    cx.shadowColor=glowColor;
    cx.shadowBlur=34;
    cx.fillStyle=glowColor;
    cx.fillText(text,X,Y);
    cx.restore();
    cx.save();
    cx.strokeStyle=glowColor;
    cx.lineWidth=Math.max(10,Math.round(fs*.035));
    cx.strokeText(text,X,Y);
    cx.restore();
    cx.save();cx.fillStyle=numberColor;cx.shadowColor='rgba(0,0,0,.18)';cx.shadowBlur=8;cx.shadowOffsetX=4;cx.shadowOffsetY=4;cx.fillText(text,X,Y);cx.restore();
    cx.save();cx.strokeStyle='rgba(0,0,0,.34)';cx.lineWidth=Math.max(6,Math.round(fs*.02));cx.strokeText(text,X,Y);cx.restore();
  }
  const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=16;t.needsUpdate=true;
  return t;
}

function makeLabelPlane(label,kind,scale,opts={}){
  const t=makeFaceTex(label,kind,opts);
  const m=new THREE.MeshBasicMaterial({map:t,transparent:true,depthWrite:false,depthTest:true,toneMapped:false});
  const mesh=new THREE.Mesh(new THREE.PlaneGeometry(scale,scale),m);
  mesh.renderOrder=20;mesh.userData.label=label;mesh.userData.kind=kind;
  return mesh;
}


function makeDiceMaterial(baseColor){
  const mat=new THREE.MeshStandardMaterial({
    color:baseColor,
    roughness:.52,
    metalness:.08,
    flatShading:true
  });
  mat.emissive=new THREE.Color(baseColor);
  mat.emissiveIntensity=.08;
  return mat;
}
function createCubeDie(values,kind='pip',opts={}){
  const dc=opts.diceColor||'#f7f8fd',nc=opts.numberColor||'#111827',gc=opts.glowColor||nc;
  const mesh=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),makeDiceMaterial(dc));
  mesh.castShadow=true;mesh.receiveShadow=true;
  mesh.userData.sides=6;mesh.userData.kind=kind;mesh.userData.faceLabels=values.slice();mesh.userData.faceKinds=values.map(()=>kind);
  mesh.userData.faceMap=[
    {normal:new THREE.Vector3(0,1,0),value:values[2]},{normal:new THREE.Vector3(0,-1,0),value:values[3]},
    {normal:new THREE.Vector3(1,0,0),value:values[0]},{normal:new THREE.Vector3(-1,0,0),value:values[1]},
    {normal:new THREE.Vector3(0,0,1),value:values[4]},{normal:new THREE.Vector3(0,0,-1),value:values[5]},
  ];
  mesh.material=values.map(n=>{const m=makeDiceMaterial(dc);m.map=makeFaceTex(n,kind,{numberColor:nc,glowColor:gc});return m;});
  return mesh;
}

function createPolyDie(sides,geometry,values,opts={},labelKind){
  const{geo,normals,centers}=triData(geometry);
  const dc=opts.diceColor||'#f7f8fd',nc=opts.numberColor||'#111827',gc=opts.glowColor||nc;
  const labels=values&&values.length===normals.length?values:Array.from({length:normals.length},(_,i)=>i+1);
  const kind=labelKind||(sides===20?'d20':sides===8?'d8':sides===10?'d10':'face');
  const mesh=new THREE.Mesh(geo,makeDiceMaterial(dc));
  mesh.castShadow=true;mesh.receiveShadow=true;
  mesh.userData.sides=sides;mesh.userData.kind=kind;mesh.userData.faceLabels=labels.slice();mesh.userData.faceKinds=labels.map(()=>kind);
  mesh.userData.faceMap=normals.map((n,i)=>({normal:n,value:labels[i]}));
  const scale=sides===20?0.56:sides===8?0.61:0.58,offset=sides===20?0.028:0.034;
  for(let i=0;i<normals.length;i++){
    const n=normals[i].clone().normalize();
    const lp=makeLabelPlane(labels[i],kind,scale,{numberColor:nc,glowColor:gc});
    lp.position.copy(centers[i]).add(n.clone().multiplyScalar(offset));
    orientToNormal(lp,n);mesh.add(lp);
  }
  return mesh;
}

function createD4Die(opts={}){
  const geo=new THREE.TetrahedronGeometry(0.72,0);
  const{geo:g}=triData(geo);
  const dc=opts.diceColor||'#f7f8fd',nc=opts.numberColor||'#111827',gc=opts.glowColor||nc;
  const mesh=new THREE.Mesh(g,makeDiceMaterial(dc));
  mesh.castShadow=true;mesh.receiveShadow=true;mesh.userData.sides=4;mesh.userData.kind='d4';
  const verts=uniqueVerts(geo).sort((a,b)=>a.y-b.y||a.x-b.x||a.z-b.z);
  mesh.userData.cornerMap=verts.map((v,i)=>({direction:v.clone().normalize(),value:i+1}));
  for(let i=0;i<verts.length;i++){
    const dir=verts[i].clone().normalize();
    const lp=makeLabelPlane(i+1,'d4',0.58,{numberColor:nc,glowColor:gc});
    lp.position.copy(verts[i]).add(dir.clone().multiplyScalar(0.08));
    orientToNormal(lp,dir);mesh.add(lp);
  }
  return mesh;
}

function createD12Die(opts={}){
  const geometry=new THREE.DodecahedronGeometry(0.74,0);
  const{geo,normals,centers}=triData(geometry);
  const dc=opts.diceColor||'#f7f8fd',nc=opts.numberColor||'#111827',gc=opts.glowColor||nc;
  // Group the 36 triangles into 12 pentagonal face groups (3 triangles share one face)
  const eps=0.01;
  const faceGroups=[];
  for(let i=0;i<normals.length;i++){
    let found=false;
    for(const fg of faceGroups){
      if(fg.normal.distanceTo(normals[i])<eps){fg.indices.push(i);fg.avgCenter.add(centers[i]);found=true;break;}
    }
    if(!found)faceGroups.push({normal:normals[i].clone(),indices:[i],avgCenter:centers[i].clone()});
  }
  for(const fg of faceGroups)fg.avgCenter.multiplyScalar(1/fg.indices.length);
  const mesh=new THREE.Mesh(geo,makeDiceMaterial(dc));
  mesh.castShadow=true;mesh.receiveShadow=true;
  mesh.userData.sides=12;mesh.userData.kind='face';
  const faceValues=Array.from({length:faceGroups.length},(_,i)=>i+1);
  mesh.userData.faceMap=faceGroups.map((fg,i)=>({normal:fg.normal,value:faceValues[i]}));
  const scale=0.58,offset=0.034;
  for(let i=0;i<faceGroups.length;i++){
    const fg=faceGroups[i];
    const n=fg.normal.clone().normalize();
    const lp=makeLabelPlane(faceValues[i],'face',scale,{numberColor:nc,glowColor:gc});
    lp.position.copy(fg.avgCenter).add(n.clone().multiplyScalar(offset));
    orientToNormal(lp,n);mesh.add(lp);
  }
  return mesh;
}

function createD10Die(opts={}){
  // Pentagonal trapezohedron: 10 kite-shaped faces, the real D10 shape
  const dc=opts.diceColor||'#f7f8fd',nc=opts.numberColor||'#111827',gc=opts.glowColor||nc;
  const s=0.76;
  // Planarity condition for kite faces: hRing = 0.10561 * hPole
  const hPole=s, hRing=0.10561*hPole, rRing=0.95*s;
  const T=new THREE.Vector3(0,hPole,0);
  const B=new THREE.Vector3(0,-hPole,0);
  const U=[],L=[];
  for(let i=0;i<5;i++){
    U.push(new THREE.Vector3(rRing*Math.cos(i*2*Math.PI/5),hRing,rRing*Math.sin(i*2*Math.PI/5)));
    L.push(new THREE.Vector3(rRing*Math.cos(i*2*Math.PI/5+Math.PI/5),-hRing,rRing*Math.sin(i*2*Math.PI/5+Math.PI/5)));
  }
  const pos=[],faceData=[];
  // Upper faces (connected to T): kite T–U[i]–L[i]–U[i+1]
  for(let i=0;i<5;i++){
    const i1=(i+1)%5;
    pos.push(T.x,T.y,T.z, L[i].x,L[i].y,L[i].z, U[i].x,U[i].y,U[i].z);
    pos.push(T.x,T.y,T.z, U[i1].x,U[i1].y,U[i1].z, L[i].x,L[i].y,L[i].z);
    const n=new THREE.Vector3().crossVectors(L[i].clone().sub(T),U[i].clone().sub(T)).normalize();
    faceData.push({normal:n,center:T.clone().add(U[i]).add(L[i]).add(U[i1]).multiplyScalar(0.25)});
  }
  // Lower faces (connected to B): kite B–L[i]–U[i+1]–L[i+1]
  for(let i=0;i<5;i++){
    const i1=(i+1)%5;
    pos.push(B.x,B.y,B.z, L[i].x,L[i].y,L[i].z, U[i1].x,U[i1].y,U[i1].z);
    pos.push(B.x,B.y,B.z, U[i1].x,U[i1].y,U[i1].z, L[i1].x,L[i1].y,L[i1].z);
    const n=new THREE.Vector3().crossVectors(L[i].clone().sub(B),U[i1].clone().sub(B)).normalize();
    faceData.push({normal:n,center:B.clone().add(L[i]).add(U[i1]).add(L[i1]).multiplyScalar(0.25)});
  }
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
  geo.computeVertexNormals();
  const mesh=new THREE.Mesh(geo,makeDiceMaterial(dc));
  mesh.castShadow=true;mesh.receiveShadow=true;
  mesh.userData.sides=10;mesh.userData.kind='d10';
  const vals=[1,2,3,4,5,6,7,8,9,10];
  mesh.userData.faceMap=faceData.map((fd,i)=>({normal:fd.normal,value:vals[i]}));
  const scale=0.55,offset=0.034;
  for(let i=0;i<faceData.length;i++){
    const lp=makeLabelPlane(vals[i],'d10',scale,{numberColor:nc,glowColor:gc});
    lp.position.copy(faceData[i].center).add(faceData[i].normal.clone().multiplyScalar(offset));
    orientToNormal(lp,faceData[i].normal);
    mesh.add(lp);
  }
  return mesh;
}

function createDieVisual(sides,opts={}){
  if(sides===3)return createCubeDie([1,1,2,2,3,3],'face',opts);
  if(sides===4)return createD4Die(opts);
  if(sides===6)return createCubeDie([3,4,1,6,2,5],'pip',opts);
  if(sides===8)return createPolyDie(8,new THREE.OctahedronGeometry(0.74,0),null,opts,'d8');
  if(sides===10)return createD10Die(opts);
  if(sides===12)return createD12Die(opts);
  if(sides===20)return createPolyDie(20,new THREE.IcosahedronGeometry(0.76,0),null,opts,'d20');
  return createCubeDie([3,4,1,6,2,5],'pip',opts);
}

function makeConvexShape(geometry){
  const geo=geometry.index?geometry.toNonIndexed():geometry.clone();
  const pos=geo.attributes.position,verts=[],faces=[],map=new Map();
  const key=(x,y,z)=>`${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`;
  const idx=(x,y,z)=>{const k=key(x,y,z);if(!map.has(k)){map.set(k,verts.length);verts.push(new CANNON.Vec3(x,y,z));}return map.get(k);};
  for(let i=0;i<pos.count;i+=3)faces.push([idx(pos.getX(i),pos.getY(i),pos.getZ(i)),idx(pos.getX(i+1),pos.getY(i+1),pos.getZ(i+1)),idx(pos.getX(i+2),pos.getY(i+2),pos.getZ(i+2))]);
  return new CANNON.ConvexPolyhedron({vertices:verts,faces});
}

function physicsShape(sides,mesh){
  if(sides===6)return new CANNON.Box(new CANNON.Vec3(0.5,0.5,0.5));
  return makeConvexShape(mesh.geometry);
}

function getDieValue(mesh){
  if(mesh.userData.sides===4&&Array.isArray(mesh.userData.cornerMap)){
    let best=-Infinity,value=1;
    for(const c of mesh.userData.cornerMap){const d=c.direction.clone().applyQuaternion(mesh.quaternion).dot(UP);if(d>best){best=d;value=c.value;}}
    return value;
  }
  let best=-Infinity,value=1;
  for(const f of mesh.userData.faceMap||[]){const d=f.normal.clone().applyQuaternion(mesh.quaternion).dot(UP);if(d>best){best=d;value=f.value;}}
  return value;
}


class CombatDiceRoller{
  constructor(){
    this.battleCanvas=document.getElementById('battlefield');
    this.diceCanvas=document.getElementById('dice-canvas');
    this._dice=[];this._rolling=false;this._settleFrames=0;this._poller=null;this._rollTimeout=null;
    this._rollMeta={rollId:null,expression:null,seed:null,shared:false};
    this._pendingSharedResult=null;
    this._rng=Math.random;
    this._draggedDieIdx=null;this._dragCurWorld=null;this._dragPrevWorld=null;this._dragCurTime=null;this._dragPrevTime=null;
    this._labelSprites=new Map();
    this.settings={diceColor:'#f7f8fd',numberColor:'#1a1a2e',glowColor:'#f7f8fd',randomizeColors:true,dieScale:1,launchVelocity:9,launchSpin:12,bounciness:0.22};
    this._init();
    this._syncSize();
    this._animate();
    const observer=new MutationObserver(()=>this._syncSize());
    observer.observe(this.battleCanvas,{attributes:true,attributeFilter:['width','height']});
  }

  _syncSize(){
    const w=this.battleCanvas.width,h=this.battleCanvas.height;
    this.diceCanvas.width=w;this.diceCanvas.height=h;
    if(this.renderer&&this.camera){
      if(this.camera.isOrthographicCamera){
        const aspect=w/h;
        const size=this._camSize||12;
        this.camera.left=-size*aspect;
        this.camera.right=size*aspect;
        this.camera.top=size;
        this.camera.bottom=-size;
        this.camera.updateProjectionMatrix();
      }else{
        this.camera.aspect=w/h;
        this.camera.updateProjectionMatrix();
      }
      this.renderer.setSize(w,h,false);
    }
  }

  _init(){
    this.scene=new THREE.Scene();
    this._camSize=12;
    this.camera=new THREE.OrthographicCamera(-1,1,1,-1,0.1,1000);
    this.camera.position.set(0,20,0);
    this.camera.up.set(0,0,-1);
    this.camera.lookAt(0,0,0);

    this.renderer=new THREE.WebGLRenderer({canvas:this.diceCanvas,antialias:true,alpha:true});
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));
    this.renderer.shadowMap.enabled=true;
    this.renderer.shadowMap.type=THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x000000,0);

    this.world=new CANNON.World({gravity:new CANNON.Vec3(0,-15,0)});
    this.world.broadphase=new CANNON.SAPBroadphase(this.world);
    this.world.allowSleep=true;
    this.world.defaultContactMaterial.friction=0.38;
    this.world.defaultContactMaterial.restitution=this.settings.bounciness;

    const floor=new CANNON.Body({mass:0,shape:new CANNON.Plane()});
    floor.quaternion.setFromEuler(-Math.PI/2,0,0);
    this.world.addBody(floor);

    [[0,0,-6.5,[0,0,0]],[0,0,6.5,[0,Math.PI,0]],[-8,0,0,[0,Math.PI/2,0]],[8,0,0,[0,-Math.PI/2,0]]].forEach(([x,y,z,rot])=>{
      const b=new CANNON.Body({mass:0,shape:new CANNON.Plane()});
      b.position.set(x,y,z);b.quaternion.setFromEuler(...rot);this.world.addBody(b);
    });

    const dir=new THREE.DirectionalLight(0xffffff,2.8);
    dir.position.set(4,10,6);dir.castShadow=true;
    dir.shadow.mapSize.set(2048,2048);
    dir.shadow.camera.left=-12;dir.shadow.camera.right=12;
    dir.shadow.camera.top=12;dir.shadow.camera.bottom=-12;
    this.scene.add(dir);
    this.scene.add(new THREE.AmbientLight(0xc8d8ff,0.9));
    const rim=new THREE.PointLight(0xffb347,12,30);rim.position.set(-5,7,-4);this.scene.add(rim);
    const fill=new THREE.PointLight(0x6688ff,8,25);fill.position.set(5,4,5);this.scene.add(fill);
  }

  applySettings(next={}){
    if(next.diceColor!==undefined)this.settings.diceColor=String(next.diceColor||'#f7f8fd');
    if(next.numberColor!==undefined)this.settings.numberColor=String(next.numberColor||this.settings.numberColor);
    if(next.glowColor!==undefined)this.settings.glowColor=String(next.glowColor||this.settings.glowColor);
    if(next.randomizeColors!==undefined)this.settings.randomizeColors=!!next.randomizeColors;
    if(next.dieScale!==undefined)this.settings.dieScale=Math.max(0.6,Math.min(2.5,parseFloat(next.dieScale)||1));
    if(next.launchVelocity!==undefined)this.settings.launchVelocity=Math.max(1,Math.min(30,parseFloat(next.launchVelocity)||9));
    if(next.launchSpin!==undefined)this.settings.launchSpin=Math.max(1,Math.min(40,parseFloat(next.launchSpin)||12));
    if(next.bounciness!==undefined)this.settings.bounciness=Math.max(0,Math.min(1,parseFloat(next.bounciness)||0));
    if(this.world?.defaultContactMaterial)this.world.defaultContactMaterial.restitution=this.settings.bounciness;
  }

  getSettings(){
    return {...this.settings};
  }

  getSharedState(){
    return {
      rollId:this._rollMeta?.rollId||null,
      expression:this._rollMeta?.expression||null,
      seed:this._rollMeta?.seed??null,
      shared:!!this._rollMeta?.shared,
      thrower:this._rollMeta?.thrower||null,
      rolling:!!this._rolling,
      results:this._pendingSharedResult?.results||null,
      total:Number.isFinite(this._pendingSharedResult?.total)?this._pendingSharedResult.total:null,
      mod:Number.isFinite(this._pendingSharedResult?.mod)?this._pendingSharedResult.mod:null,
      prompt:lastDicePrompt?{id:lastDicePrompt,expression:this._rollMeta?.expression||'1d20'}:null
    };
  }

  clearDice(opts={}){
    if(this._rollTimeout){clearTimeout(this._rollTimeout);this._rollTimeout=null;}
    if(this._poller){clearInterval(this._poller);this._poller=null;}
    this._rolling=false;
    this._settleFrames=0;
    this._pendingSharedResult=null;
    this._rollMeta={rollId:null,expression:null,seed:null,shared:false};
    if(window.__isHost) lastDicePrompt=null;
    this._removeAllDice();
    const r=document.getElementById('diceResult');
    if(r){r.className='';r.innerHTML='';}
    if(opts.broadcast&&window.__isHost&&window.__broadcastAppMessage){
      window.__broadcastAppMessage({type:'dice_clear',source:'host'});
    }
  }

  _removeAllDice(){
    for(const d of this._dice){
      this.scene.remove(d.mesh);
      this.world.removeBody(d.body);
    }
    this._dice=[];
    for(const sprite of this._labelSprites.values())this.scene.remove(sprite);
    this._labelSprites.clear();
  }

  _setRngSeed(seed){
    const s=(seed===undefined||seed===null) ? null : (seed>>>0);
    this._rng=s===null ? Math.random : mulberry32(s);
    return this._rng;
  }

  startSharedRoll(payload){
    const expression=String(payload?.expression||'1d20').trim()||'1d20';
    const rollId=payload?.rollId||makeDiceRequestId();
    const seed=payload?.seed!==undefined ? (payload.seed>>>0) : hashStringToSeed(`${rollId}|${expression}`);
    if(payload?.diceSettings) this.applySettings(payload.diceSettings);
    this._pendingSharedResult=null;
    this._rollMeta={rollId,expression,seed,shared:true};
    this._setRngSeed(seed);
    const thrower=payload?.fromGuestName||payload?.guestName||null;
    this.roll(expression,{rollId,seed,shared:true,thrower,broadcast:false,passive:!window.__isHost});
  }

  getReplicationState(){
    return {
      rollId:this._rollMeta?.rollId||null,
      expression:this._rollMeta?.expression||null,
      seed:this._rollMeta?.seed??null,
      shared:!!this._rollMeta?.shared,
      thrower:this._rollMeta?.thrower||null,
      diceSettings:this.getSettings(),
      rolling:!!this._rolling,
      mod:Number.isFinite(this._lastMod)?this._lastMod:null,
      results:this._pendingSharedResult?.results||null,
      total:Number.isFinite(this._pendingSharedResult?.total)?this._pendingSharedResult.total:null,
      dice:this._dice.map((d,idx)=>({
        idx,
        sides:d.sides,
        sign:d.sign,
        thrower:d.thrower||null,
        scale:Number.isFinite(d.mesh?.scale?.x)?d.mesh.scale.x:1,
        position:{x:d.body.position.x,y:d.body.position.y,z:d.body.position.z},
        quaternion:{x:d.body.quaternion.x,y:d.body.quaternion.y,z:d.body.quaternion.z,w:d.body.quaternion.w},
        velocity:{x:d.body.velocity.x,y:d.body.velocity.y,z:d.body.velocity.z},
        angularVelocity:{x:d.body.angularVelocity.x,y:d.body.angularVelocity.y,z:d.body.angularVelocity.z},
        sleeping:d.body.sleepState===CANNON.Body.SLEEPING,
      })),
    };
  }

  applySharedState(snapshot){
    if(!snapshot)return;
    if(this._rollMeta.rollId && snapshot.rollId && snapshot.rollId!==this._rollMeta.rollId)return;
    if(snapshot.diceSettings) this.applySettings(snapshot.diceSettings);
    if(snapshot.rollId && !this._rollMeta.rollId){
      this._rollMeta.rollId=snapshot.rollId;
      this._rollMeta.expression=snapshot.expression||this._rollMeta.expression||null;
      this._rollMeta.seed=snapshot.seed??this._rollMeta.seed??null;
      this._rollMeta.shared=!!snapshot.shared;
    }
    const diceState=Array.isArray(snapshot.dice)?snapshot.dice:null;
    if(!diceState)return;
    const needsRebuild=
      this._dice.length!==diceState.length ||
      diceState.some((snap,idx)=>{
        const d=this._dice[idx];
        return !d || d.sides!==snap.sides || (d.sign??1)!==(snap.sign??1);
      });
    if(needsRebuild){
      this._removeAllDice();
      for(const snap of diceState){
        this._spawnReplicatedDie(snap);
      }
    }
    if(!this._dice.length)return;
    for(const snap of diceState){
      const d=this._dice[snap.idx];
      if(!d)continue;
      if(snap.position){d.body.position.set(snap.position.x||0,snap.position.y||0,snap.position.z||0);}
      if(snap.quaternion){d.body.quaternion.set(snap.quaternion.x||0,snap.quaternion.y||0,snap.quaternion.z||0,snap.quaternion.w??1);}
      if(snap.velocity){d.body.velocity.set(snap.velocity.x||0,snap.velocity.y||0,snap.velocity.z||0);}
      if(snap.angularVelocity){d.body.angularVelocity.set(snap.angularVelocity.x||0,snap.angularVelocity.y||0,snap.angularVelocity.z||0);}
      if(snap.sleeping&&typeof d.body.sleep==='function') d.body.sleep();
      else if(typeof d.body.wakeUp==='function') d.body.wakeUp();
    }
  }

  _spawnReplicatedDie(snap={}){
    const sides=Number.isFinite(snap.sides)?snap.sides:20;
    const sign=Number.isFinite(snap.sign)?snap.sign:1;
    const thrower=snap.thrower||null;
    const rand=Math.random;
    const colors=this.settings.randomizeColors ? getRandomDieColors(rand) : getFixedDieColors(this.settings.diceColor,rand);
    const mesh=createDieVisual(sides,{...this.settings,...colors});
    const scale=Math.max(0.6,Math.min(2.5,parseFloat(snap.scale)||this.settings.dieScale||1));
    if(mesh.scale?.setScalar) mesh.scale.setScalar(scale);
    const body=new CANNON.Body({mass:0});
    body.type=CANNON.Body.KINEMATIC;
    body.velocity.set(0,0,0);
    body.angularVelocity.set(0,0,0);
    body.linearDamping=1;
    body.angularDamping=1;
    body.allowSleep=false;
    body.addShape(physicsShape(sides,mesh));
    this.scene.add(mesh);
    this.world.addBody(body);
    this._dice.push({sides,mesh,body,sign,thrower});
  }

  _broadcastRollingState(){
    if(!window.__isHost||!window.__broadcastAppMessage||!this._rolling)return;
    const now=Date.now();
    if(this._lastStateBroadcastAt && now-this._lastStateBroadcastAt<16)return;
    this._lastStateBroadcastAt=now;
    window.__broadcastAppMessage({type:'dice_roll_state',state:this.getReplicationState(),source:'host'});
  }

  applySharedResult(payload){
    if(!payload)return;
    if(this._rollMeta.rollId && payload.rollId && payload.rollId!==this._rollMeta.rollId)return;
    const results=Array.isArray(payload.results)?payload.results:[];
    const total=Number.isFinite(payload.total)?payload.total:null;
    this._pendingSharedResult={...payload,results,total};
    if(payload.diceState) this.applySharedState(payload.diceState);
    if(Array.isArray(payload.results)||Number.isFinite(payload.total)) this._rolling=false;
    if(!this._rolling) this._renderSharedResult(payload);
  }

  _renderSharedResult(payload){
    const results=Array.isArray(payload.results)?payload.results:[];
    const total=Number.isFinite(payload.total)?payload.total:results.reduce((acc,r)=>acc+(r.sign||1)*(r.value||0),payload.mod||0);
    const parts=results.map(r=>`${(r.sign||1)<0?'−':''}${r.value}`);
    if((payload.mod||0)!==0)parts.push((payload.mod>0?'+':'')+payload.mod);
    const breakdown=parts.join(' + ').replace(/\+ −/g,'− ');
    const r=document.getElementById('diceResult');
    if(r){
      r.className='';
      r.innerHTML=`<div class="dice-result-total">${total}</div><div class="dice-result-breakdown">${breakdown}</div>`;
    }
  }

  // ── PHYSICAL DIE INTERACTION ──────────────────────────────────
  canvasToWorld(cssPx,cssPy){
    const rect=this.diceCanvas.getBoundingClientRect();
    const nx=cssPx/rect.width, ny=cssPy/rect.height;
    const cam=this.camera;
    return{wx:cam.left+nx*(cam.right-cam.left),wz:-cam.top+ny*(cam.top-cam.bottom)};
  }

  findDieAt(cssPx,cssPy){
    if(!this._dice.length)return -1;
    const{wx,wz}=this.canvasToWorld(cssPx,cssPy);
    let best=-1,bestD=1.4;
    for(let i=0;i<this._dice.length;i++){
      const b=this._dice[i].body;
      const dx=b.position.x-wx,dz=b.position.z-wz;
      const d=Math.sqrt(dx*dx+dz*dz);
      if(d<bestD){bestD=d;best=i;}
    }
    return best;
  }

  startDieDrag(dieIdx,cssPx,cssPy){
    if(dieIdx<0||dieIdx>=this._dice.length)return false;
    if(this._poller){clearInterval(this._poller);this._poller=null;}
    if(this._rollTimeout){clearTimeout(this._rollTimeout);this._rollTimeout=null;}
    const d=this._dice[dieIdx];
    d.body.type=CANNON.Body.KINEMATIC;
    d.body.velocity.set(0,0,0);
    d.body.angularVelocity.set(0,0,0);
    this._draggedDieIdx=dieIdx;
    const{wx,wz}=this.canvasToWorld(cssPx,cssPy);
    this._dragCurWorld={wx,wz};this._dragPrevWorld={wx,wz};
    this._dragCurTime=performance.now();this._dragPrevTime=performance.now();
    d.body.position.set(wx,1.5,wz);
    this._rolling=false;
    const r=document.getElementById('diceResult');
    if(r){r.className='rolling';r.textContent='✋ Held…';}
    return true;
  }

  updateDieDrag(cssPx,cssPy){
    if(this._draggedDieIdx==null||this._draggedDieIdx<0)return;
    const d=this._dice[this._draggedDieIdx];
    if(!d)return;
    const{wx,wz}=this.canvasToWorld(cssPx,cssPy);
    this._dragPrevWorld=this._dragCurWorld;
    this._dragPrevTime=this._dragCurTime;
    this._dragCurWorld={wx,wz};
    this._dragCurTime=performance.now();
    d.body.position.set(wx,1.5,wz);
    d.body.velocity.set(0,0,0);
    d.body.angularVelocity.set(0,0,0);
  }

  releaseDieDrag(){
    if(this._draggedDieIdx==null||this._draggedDieIdx<0){this._draggedDieIdx=null;return;}
    const d=this._dice[this._draggedDieIdx];
    if(!d){this._draggedDieIdx=null;return;}
    d.body.type=CANNON.Body.DYNAMIC;
    const cur=this._dragCurWorld||{wx:0,wz:0};
    const prev=this._dragPrevWorld||cur;
    const dt=Math.max(0.016,((this._dragCurTime||0)-(this._dragPrevTime||0))/1000);
    const throwScale=10;
    const rawVx=(cur.wx-prev.wx)/dt*throwScale;
    const rawVz=(cur.wz-prev.wz)/dt*throwScale;
    const speed=Math.sqrt(rawVx*rawVx+rawVz*rawVz);
    const maxSpeed=this.settings.launchVelocity*4;
    const clamp=speed>maxSpeed?maxSpeed/speed:1;
    const vx=rawVx*clamp, vz=rawVz*clamp;
    const vy=4+speed*clamp*0.2;
    d.body.velocity.set(vx,vy,vz);
    const sp=this.settings.launchSpin;
    const rand=Math.random; // Use true randomness for throws (no seed reuse)
    d.body.angularVelocity.set((rand()-0.5)*sp,(rand()-0.5)*sp,(rand()-0.5)*sp);
    d.body.wakeUp?.();

    const throwData={
      dieIndex:0,
      sides:d.sides,
      sign:d.sign||1,
      position:{x:d.body.position.x,y:d.body.position.y,z:d.body.position.z},
      quaternion:{x:d.body.quaternion.x,y:d.body.quaternion.y,z:d.body.quaternion.z,w:d.body.quaternion.w},
      velocity:{x:vx,y:vy,z:vz},
      angularVelocity:{x:d.body.angularVelocity.x,y:d.body.angularVelocity.y,z:d.body.angularVelocity.z},
    };

    // Guests cannot authoritatively broadcast roll start/state/result.
    // Route die-throws through the normal guest request flow so host simulation is shared to everyone.
    if(!window.__isHost){
      this._draggedDieIdx=null;
      this._dragCurWorld=null;this._dragPrevWorld=null;
      d.body.type=CANNON.Body.KINEMATIC;
      d.body.velocity.set(0,0,0);
      d.body.angularVelocity.set(0,0,0);
      const expr=`${(d.sign||1)<0?'-':''}1d${d.sides}`;
      if(typeof window.requestDiceRoll==='function'){
        window.requestDiceRoll(expr,{prompted:true,fromDieThrow:true,throwData});
      }else{
        const r=document.getElementById('diceResult');
        if(r){r.className='rolling';r.textContent='⏳ Request sent to DM…';}
      }
      return;
    }

    this._draggedDieIdx=null;
    this._dragCurWorld=null;this._dragPrevWorld=null;

    // Assign a fresh rollId so this throw is treated as a new roll
    const freshRollId=crypto?.randomUUID?.() || `throw-${Date.now().toString(36)}`;
    this._rollMeta.rollId=freshRollId;
    this._rollMeta.seed=null;
    this._rollMeta.shared=true;
    this._pendingSharedResult=null;
    this._setRngSeed(null); // Unseed RNG so result reading is not deterministic

    // Broadcast roll start to guests so they see the throw
    if(window.__isHost && window.__broadcastAppMessage){
      window.__broadcastAppMessage({type:'dice_roll_start',...this._rollMeta,diceSettings:this.getSettings(),source:'host'});
    }

    // Restart settle poller so die reads new value
    this._settleFrames=0;
    this._rolling=true;
    const r=document.getElementById('diceResult');
    if(r){r.className='rolling';r.textContent='🎲 Rolling…';}
    if(this._poller)clearInterval(this._poller);
    const{mod}=parseExpression(this._rollMeta.expression||'');
    const expr=this._rollMeta.expression||'thrown';
    this._poller=setInterval(()=>{
      if(!this._rolling){clearInterval(this._poller);this._poller=null;return;}
      // Broadcast physics state to guests during throw settle
      if(window.__isHost) this._broadcastRollingState();
      const still=this._dice.every(di=>di.body.velocity.lengthSquared()<0.01&&di.body.angularVelocity.lengthSquared()<0.01);
      this._settleFrames=still?this._settleFrames+1:0;
      if(this._settleFrames>28||this._dice.every(di=>di.body.sleepState===CANNON.Body.SLEEPING)){
        this._finishRoll(mod,expr);clearInterval(this._poller);this._poller=null;
      }
    },80);
    if(this._rollTimeout)clearTimeout(this._rollTimeout);
    this._rollTimeout=setTimeout(()=>{if(this._rolling)this._forceFinish(expr,mod);},8000);
  }

  spawnDie(sides,index,total,sign,thrower,opts={}){
    const rand=this._rng||Math.random;
    const colors=this.settings.randomizeColors ? getRandomDieColors(rand) : getFixedDieColors(this.settings.diceColor,rand);
    const scale=Math.max(0.6,this.settings.dieScale||1);
    const mesh=createDieVisual(sides,{...this.settings,...colors});
    if(mesh.scale?.setScalar) mesh.scale.setScalar(scale);
    const passive=!!opts.passive;
    const body=new CANNON.Body({mass:passive?0:1});
    const spread=Math.min(1.4,8/total);
    body.position.set((index-(total-1)/2)*spread,5*scale+index*0.12*scale,-1.2+rand()*0.8);
    body.quaternion.setFromEuler(rand()*Math.PI,rand()*Math.PI,rand()*Math.PI);
    const v=this.settings.launchVelocity,sp=this.settings.launchSpin;
    if(passive){
      body.type=CANNON.Body.KINEMATIC;
      body.velocity.set(0,0,0);
      body.angularVelocity.set(0,0,0);
      body.linearDamping=1;body.angularDamping=1;body.allowSleep=false;
    }else{
      body.velocity.set((rand()-.5)*v*1.5,v*0.6+rand()*v*0.4+1.5,(rand()-.5)*v*1.5);
      body.angularVelocity.set((rand()-.5)*sp,(rand()-.5)*sp,(rand()-.5)*sp);
      body.linearDamping=0.22;body.angularDamping=0.28;body.allowSleep=true;body.sleepSpeedLimit=0.08;body.sleepTimeLimit=0.8;
    }
    body.addShape(physicsShape(sides,mesh));
    this.scene.add(mesh);this.world.addBody(body);
    this._dice.push({sides,mesh,body,sign,thrower:thrower||null});
  }

  roll(expression,opts={}){
    const passive=!!opts.passive || !window.__isHost;
    if(this._rolling){
      if(passive)this.clearDice();
      else return;
    }
    this._rolling=true;
    const r=document.getElementById('diceResult');
    if(r){r.className='rolling';r.textContent='🎲 Rolling…';}
    const{dice,mod}=parseExpression(expression);
    this.clearDice();
    this._rolling=true;
    const resultEl=document.getElementById('diceResult');
    if(resultEl){resultEl.className='rolling';resultEl.textContent='🎲 Rolling…';}
    this._rollMeta={rollId:opts.rollId||this._rollMeta.rollId||null,expression,seed:opts.seed??this._rollMeta.seed??null,shared:!!opts.shared,thrower:opts.thrower||null};
    this._setRngSeed(this._rollMeta.seed);
    if(window.__isHost && opts.broadcast!==false && window.__broadcastAppMessage){
      window.__broadcastAppMessage({type:'dice_roll_start',...this._rollMeta,throwData:opts.throwData||null,diceSettings:this.getSettings(),source:'host'});
      syncToServer();
    }
    let idx=0;const total=dice.reduce((s,d)=>s+d.count,0);
    for(const part of dice)for(let i=0;i<part.count;i++)this.spawnDie(part.sides,idx++,total,part.sign,this._rollMeta.thrower,{passive});

    const td=opts.throwData;
    if(td&&!passive&&this._dice.length){
      let targetIdx=Number.isInteger(td.dieIndex)?Math.max(0,Math.min(this._dice.length-1,td.dieIndex)):0;
      if(Number.isFinite(td.sides)){
        const sideMatch=this._dice.findIndex(di=>di.sides===td.sides&&((td.sign||1)<0?di.sign<0:di.sign>0));
        if(sideMatch>=0)targetIdx=sideMatch;
      }
      const target=this._dice[targetIdx];
      if(target){
        if(td.position&&Number.isFinite(td.position.x)&&Number.isFinite(td.position.y)&&Number.isFinite(td.position.z)){
          target.body.position.set(td.position.x,td.position.y,td.position.z);
        }
        if(td.quaternion&&Number.isFinite(td.quaternion.x)&&Number.isFinite(td.quaternion.y)&&Number.isFinite(td.quaternion.z)&&Number.isFinite(td.quaternion.w)){
          target.body.quaternion.set(td.quaternion.x,td.quaternion.y,td.quaternion.z,td.quaternion.w);
        }
        if(td.velocity&&Number.isFinite(td.velocity.x)&&Number.isFinite(td.velocity.y)&&Number.isFinite(td.velocity.z)){
          target.body.velocity.set(td.velocity.x,td.velocity.y,td.velocity.z);
        }
        if(td.angularVelocity&&Number.isFinite(td.angularVelocity.x)&&Number.isFinite(td.angularVelocity.y)&&Number.isFinite(td.angularVelocity.z)){
          target.body.angularVelocity.set(td.angularVelocity.x,td.angularVelocity.y,td.angularVelocity.z);
        }
        target.body.wakeUp?.();
      }
    }

    if(passive){
      this._settleFrames=0;
      return;
    }
    if(window.__isHost) this._broadcastRollingState();
    this._settleFrames=0;
    if(this._poller)clearInterval(this._poller);
    if(this._rollTimeout)clearTimeout(this._rollTimeout);
    this._rollTimeout=setTimeout(()=>{
      if(this._rolling) this._forceFinish(expression,mod);
    }, Math.max(6000, 1200 * Math.max(1,total)));
    this._poller=setInterval(()=>{
      if(!this._rolling){clearInterval(this._poller);this._poller=null;return;}
      const still=this._dice.every(d=>d.body.velocity.lengthSquared()<0.01&&d.body.angularVelocity.lengthSquared()<0.01);
      this._settleFrames=still?this._settleFrames+1:0;
      if(this._settleFrames>28||this._dice.every(d=>d.body.sleepState===CANNON.Body.SLEEPING)){
        this._finishRoll(mod,expression);clearInterval(this._poller);this._poller=null;
      }
    },80);
  }

  _forceFinish(expression,mod){
    for(const d of this._dice){
      if(d.body.velocity?.setZero)d.body.velocity.setZero();
      else d.body.velocity.set(0,0,0);
      if(d.body.angularVelocity?.setZero)d.body.angularVelocity.setZero();
      else d.body.angularVelocity.set(0,0,0);
      if(typeof d.body.sleep === 'function') d.body.sleep();
    }
    this._finishRoll(mod,expression);
  }

  _finishRoll(mod,expression){
    if(this._rollTimeout){clearTimeout(this._rollTimeout);this._rollTimeout=null;}
    const localResults=this._dice.map(d=>({sides:d.sides,value:getDieValue(d.mesh),sign:d.sign}));
    let results=localResults;
    let total=localResults.reduce((acc,r)=>acc+r.sign*r.value,mod);
    let parts=localResults.map(r=>`${r.sign<0?'−':''}${r.value}`);
    if(mod!==0)parts.push((mod>0?'+':'')+mod);
    let breakdown=parts.join(' + ').replace(/\+ −/g,'− ');

    if(this._pendingSharedResult&&this._pendingSharedResult.rollId===this._rollMeta.rollId){
      const pr=this._pendingSharedResult;
      if(Array.isArray(pr.results)&&pr.results.length)results=pr.results;
      if(Number.isFinite(pr.total))total=pr.total;
      const pparts=results.map(r=>`${(r.sign||1)<0?'−':''}${r.value}`);
      if((pr.mod||0)!==0)pparts.push((pr.mod>0?'+':'')+pr.mod);
      breakdown=pparts.join(' + ').replace(/\+ −/g,'− ');
    }

    for(const d of this._dice){
      if(d.body.velocity?.setZero)d.body.velocity.setZero(); else d.body.velocity.set(0,0,0);
      if(d.body.angularVelocity?.setZero)d.body.angularVelocity.setZero(); else d.body.angularVelocity.set(0,0,0);
      if(typeof d.body.sleep === 'function') d.body.sleep();
    }

    const r=document.getElementById('diceResult');
    if(r){
      r.className='';
      r.innerHTML=`<div class="dice-result-total">${total}</div><div class="dice-result-breakdown">${breakdown}</div>`;
    }

    this._lastMod=mod;
    const payload={rollId:this._rollMeta.rollId,expression,mod,total,results,shared:!!this._rollMeta.shared,diceState:this.getReplicationState()};
    this._rolling=false;
    this._pendingSharedResult={results,total,mod,rollId:this._rollMeta.rollId};
    document.dispatchEvent(new CustomEvent('dice-result',{detail:payload}));
    if(window.__isHost && window.__broadcastAppMessage){
      window.__broadcastAppMessage({type:'dice_roll_result',...payload,source:'host'});
      syncToServer();
    }
  }

  _animate=()=>{
    requestAnimationFrame(this._animate);
    // Guests need local stepping for direct drag-throws; shared host rolls remain host-authoritative via replicated state.
    if(this.world)this.world.step(1/60);
    for(const d of this._dice){d.mesh.position.copy(d.body.position);d.mesh.quaternion.copy(d.body.quaternion);}
    if(window.__isHost) this._broadcastRollingState();
    // Draw thrower names above dice groups
    this._drawThrowerLabels();
    if(this.renderer&&this.scene&&this.camera)this.renderer.render(this.scene,this.camera);
  };

  _drawThrowerLabels(){
    // Collect distinct throwers and find average XZ position of their dice
    const throwerGroups=new Map();
    for(const d of this._dice){
      const name=d.thrower;
      if(!name)continue;
      if(!throwerGroups.has(name))throwerGroups.set(name,{x:0,z:0,count:0,maxY:d.body.position.y});
      const g=throwerGroups.get(name);
      g.x+=d.body.position.x;g.z+=d.body.position.z;g.count++;g.maxY=Math.max(g.maxY,d.body.position.y);
    }
    // Remove stale label sprites
    for(const [name,sprite] of this._labelSprites){
      if(!throwerGroups.has(name)){this.scene.remove(sprite);this._labelSprites.delete(name);}
    }
    // Create/update label sprites
    for(const [name,g] of throwerGroups){
      const avgX=g.x/g.count,avgZ=g.z/g.count;
      if(!this._labelSprites.has(name)){
        const sprite=this._makeLabelSprite(name);
        this.scene.add(sprite);
        this._labelSprites.set(name,sprite);
      }
      const sprite=this._labelSprites.get(name);
      sprite.position.set(avgX,g.maxY+0.3,avgZ-2.2);
    }
  }

  _makeLabelSprite(text){
    const label=text.length>18?text.slice(0,17)+'…':text;
    const c=document.createElement('canvas');c.width=256;c.height=48;
    const ctx=c.getContext('2d');
    ctx.clearRect(0,0,256,48);
    ctx.font='bold 26px sans-serif';
    ctx.textAlign='center';ctx.textBaseline='middle';
    // shadow for legibility
    ctx.shadowColor='rgba(0,0,0,0.9)';ctx.shadowBlur=6;
    ctx.fillStyle='#ffffff';
    ctx.fillText(label,128,24);
    ctx.shadowBlur=0;
    const tex=new THREE.CanvasTexture(c);
    const mat=new THREE.SpriteMaterial({map:tex,depthTest:false,transparent:true});
    const sprite=new THREE.Sprite(mat);
    sprite.scale.set(2.8,0.53,1);
    return sprite;
  }

  rollForAll(expression,guestNames){
    // Spawns one die group per guest (or DM if guestNames is empty), each labeled with that person's name
    if(this._rolling)return;
    this._rolling=true;
    const r=document.getElementById('diceResult');
    if(r){r.className='rolling';r.textContent='🎲 Rolling for all…';}
    const{dice,mod}=parseExpression(expression);
    this.clearDice();
    this._rolling=true;
    const participants=guestNames&&guestNames.length?guestNames:['DM'];
    const dicePerPerson=dice.reduce((s,d)=>s+d.count,0);
    const total=dicePerPerson*participants.length;
    this._rollMeta={rollId:null,expression,seed:null,shared:false,thrower:'all'};
    this._setRngSeed(null);
    let globalIdx=0;
    for(let pi=0;pi<participants.length;pi++){
      const thrower=participants[pi];
      const offsetX=(pi-(participants.length-1)/2)*Math.max(1.8,dicePerPerson*1.2+0.5);
      let localIdx=0;
      for(const part of dice){
        for(let i=0;i<part.count;i++){
          const rand=this._rng||Math.random;
          const colors=this.settings.randomizeColors?getRandomDieColors(rand):getFixedDieColors(this.settings.diceColor,rand);
          const scale=Math.max(0.6,this.settings.dieScale||1);
          const mesh=createDieVisual(part.sides,{...this.settings,...colors});
          if(mesh.scale?.setScalar)mesh.scale.setScalar(scale);
          const body=new CANNON.Body({mass:1});
          const spread=Math.min(1.2,6/dicePerPerson);
          body.position.set(offsetX+(localIdx-(dicePerPerson-1)/2)*spread,5*scale+globalIdx*0.12*scale,-1.2+rand()*0.8);
          body.quaternion.setFromEuler(rand()*Math.PI,rand()*Math.PI,rand()*Math.PI);
          const v=this.settings.launchVelocity,sp=this.settings.launchSpin;
          body.velocity.set((rand()-.5)*v*1.5,v*0.6+rand()*v*0.4+1.5,(rand()-.5)*v*1.5);
          body.angularVelocity.set((rand()-.5)*sp,(rand()-.5)*sp,(rand()-.5)*sp);
          body.linearDamping=0.22;body.angularDamping=0.28;body.allowSleep=true;body.sleepSpeedLimit=0.08;body.sleepTimeLimit=0.8;
          body.addShape(physicsShape(part.sides,mesh));
          this.scene.add(mesh);this.world.addBody(body);
          this._dice.push({sides:part.sides,mesh,body,sign:part.sign,thrower});
          localIdx++;globalIdx++;
        }
      }
    }
    this._settleFrames=0;
    if(this._poller)clearInterval(this._poller);
    if(this._rollTimeout)clearTimeout(this._rollTimeout);
    this._rollTimeout=setTimeout(()=>{if(this._rolling)this._forceFinish(expression,mod);},Math.max(6000,1200*Math.max(1,total)));
    this._poller=setInterval(()=>{
      if(!this._rolling){clearInterval(this._poller);this._poller=null;return;}
      const still=this._dice.every(d=>d.body.velocity.lengthSquared()<0.01&&d.body.angularVelocity.lengthSquared()<0.01);
      this._settleFrames=still?this._settleFrames+1:0;
      if(this._settleFrames>28||this._dice.every(d=>d.body.sleepState===CANNON.Body.SLEEPING)){
        this._finishRoll(mod,expression);clearInterval(this._poller);this._poller=null;
      }
    },80);
  }
}
const combatDice=new CombatDiceRoller();
window.combatDice=combatDice;
combatDice.applySettings(clampDiceSettings());
window.rollCombatDice=(expr,opts={})=>combatDice.roll(expr,opts);
window.startSharedDiceRoll=(payload)=>combatDice.startSharedRoll(payload);
window.applySharedDiceResult=(payload)=>combatDice.applySharedResult(payload);
window.applySharedDiceState=(payload)=>combatDice.applySharedState(payload);
window.clearCombatDice=(opts={})=>combatDice.clearDice(opts);
window.syncDiceCanvas=()=>combatDice._syncSize();
