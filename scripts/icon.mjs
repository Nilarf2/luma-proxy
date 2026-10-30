import fs from 'node:fs';
import { PNG } from 'pngjs';
const size=256;const png=new PNG({width:size,height:size});
for(let y=0;y<size;y++)for(let x=0;x<size;x++){const i=(size*y+x)*4;const cx=Math.max(45,Math.min(210,x)),cy=Math.max(45,Math.min(210,y));const inside=Math.hypot(x-cx,y-cy)<45;let c=[245,247,242,inside?255:0];const skew=(x-82)*.25;const bars=[[76,99,75,184,[48,64,51]],[117,140,107,184,[132,151,129]],[158,181,139,184,[82,119,86]]];for(const [a,b,t,bot,color]of bars)if(x>=a&&x<b&&y>=t-skew&&y<bot-skew)c=[...color,255];for(let k=0;k<4;k++)png.data[i+k]=c[k];}
const data=PNG.sync.write(png);fs.mkdirSync('resources',{recursive:true});fs.writeFileSync('resources/icon.png',data);
const header=Buffer.alloc(22);header.writeUInt16LE(1,2);header.writeUInt16LE(1,4);header[6]=0;header[7]=0;header.writeUInt16LE(1,10);header.writeUInt16LE(32,12);header.writeUInt32LE(data.length,14);header.writeUInt32LE(22,18);fs.writeFileSync('resources/icon.ico',Buffer.concat([header,data]));
