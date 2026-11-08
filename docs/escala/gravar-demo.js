// Regrava docs/escala/demo-escalabilidade.* a partir de simulacao-escala.html.
// Uso (fora do projeto): npm i playwright-core ffmpeg-static
//   CHROME=/caminho/do/chrome node gravar-demo.js        -> vid/*.webm (tempo real, ~2min30)
//   ffmpeg -i vid/X.webm -vf "setpts=PTS/2,fps=24" -c:v libx264 -crf 30 -pix_fmt yuv420p demo-escalabilidade.mp4
//   ffmpeg -i vid/X.webm -vf "setpts=PTS/4,fps=5,scale=880:-1,split[a][b];[a]palettegen=max_colors=32[p];[b][p]paletteuse=dither=none" demo-escalabilidade.gif
const path = require('node:path');
const { chromium } = require('playwright-core');
const W=1600,H=800;
(async()=>{
 const b=await chromium.launch({executablePath:process.env.CHROME});
 const ctx=await b.newContext({viewport:{width:W,height:H},recordVideo:{dir:'vid',size:{width:W,height:H}}});
 const p=await ctx.newPage();
 p.on('pageerror',e=>console.log('ERR',e.message));
 await p.goto('file://'+path.resolve(__dirname,'simulacao-escala.html'));
 await p.addStyleTag({content:`#capx{position:fixed;left:150px;bottom:16px;z-index:99;background:#0f2a22ee;color:#f2f7f4;font:500 21px/1.35 'IBM Plex Sans',system-ui,sans-serif;padding:12px 22px;border-radius:10px;max-width:1000px;box-shadow:0 6px 24px #0005;transition:opacity .4s}
 #capx b{color:#7fe0b4;font-family:'JetBrains Mono',monospace;font-weight:600;margin-right:10px}
 #capx small{display:block;font-size:15px;opacity:.8;margin-top:2px}
 *{scroll-behavior:auto!important}`});
 const cap=(n,t,s='')=>p.evaluate(([n,t,s])=>{let e=document.getElementById('capx');if(!e){e=document.createElement('div');e.id='capx';document.body.appendChild(e)}e.innerHTML=`<b>${n}</b>${t}${s?`<small>${s}</small>`:''}`},[n,t,s]);
 const click=id=>p.evaluate(id=>document.getElementById(id).click(),id);
 const y=sel=>p.evaluate(s=>document.querySelector(s).getBoundingClientRect().top+scrollY,sel);
 const scroll=async(to,ms=900)=>{await p.evaluate(async([to,ms])=>{const f=scrollY,t0=performance.now();await new Promise(r=>{const st=()=>{const k=Math.min(1,(performance.now()-t0)/ms),e=k<.5?2*k*k:1-Math.pow(-2*k+2,2)/2;scrollTo(0,f+(to-f)*e);k<1?requestAnimationFrame(st):r()};st()})},[to,ms])};
 const w=ms=>p.waitForTimeout(ms);
 const diag=(await y('.phases'))-14;
 const panel=(await y('#sloGrid'))-90;

 await cap('Jungle Wallet','Demonstração de escalabilidade','do uso baixo até 4 milhões de req/s em células');
 await w(3500);
 await scroll(diag,1400);
 await click('bLow'); await cap('1 · Uso baixo','800 req/s: 2 boxes, 2 instâncias de escrita, 2 de leitura','fila vazia, resposta na hora');
 await w(9000);
 await click('bPeak'); await cap('2 · Pico de 30 mil','O load balancer espalha, as boxes sobem e a fila segura o excesso','enquanto o autoscaler (KEDA, pela idade da fila) liga mais instâncias de escrita');
 await w(24000);
 await click('bBig'); await w(400); await click('bPeak7');
 await cap('3 · Perfil 700 mil','Cada nó vira um grupo (×N): até 96 boxes, 192 escritas, 20 shards','fila justa por provedor e instâncias aquecidas · 3.000 provedores com cota própria');
 await w(26000);
 await click('bHuge'); await w(400); await click('bPeak4');
 await cap('4 · Pico de 4 milhões','8 células: cópias da pilha, cada uma dona de uma fatia das carteiras','roteador global por hash(walletId) · o diagrama mostra a célula 1');
 await w(16000);
 await click('bCell');
 await cap('5 · Uma célula cai','Só 1/8 das carteiras espera o failover; as outras 7 células seguem','raio de estrago de 12,5% em vez de 100% · volta em 12 s');
 await w(11000);
 await scroll(panel,1200);
 await cap('6 · Painel de métricas','Plataforma inteira: disponibilidade, p95, saturação por camada','SLO de 99,9% · capacidade ~9 mi req/s · custo estimado por hora');
 await w(8000);
 await scroll(diag,1200);
 await cap('7 · O pico passa','A fila drena e o autoscaler devolve instâncias com histerese','sobe a 85% de uso, só desce abaixo de 60% · sem oscilação');
 await w(30000);
 await cap('Jungle Wallet','PostgreSQL é a fonte da verdade · filas SQS at-least-once · repetição idempotente','simulação ilustrativa: capacidades e tempos são estimativas do modelo');
 await w(5000);
 await ctx.close(); await b.close();
})();
