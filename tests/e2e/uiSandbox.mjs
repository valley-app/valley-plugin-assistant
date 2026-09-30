import assert from 'node:assert/strict'
import path from 'node:path'
import buildPackage from '../../build.mjs'

export default async function ({ directory }) {
  const root = path.resolve(import.meta.dirname, '../..')
  const harnessSource = `export function register(api){return{id:'fixture',cases:[api.case({id:'loop',name:'Tool loop',async run(context){const thread=context.createThread({messages:[{role:'user',content:'Describe the plants'}],tools:[{definition:{name:'read_plants',description:'Read',parameters:{type:'object'}},handle(){return{plants:['fern','moss']}}}],autoTools:true});const result=await thread.run();return{status:result.text.includes('fern')?'pass':'fail',metrics:{transcript_messages:thread.transcript().length,isolated:Number(typeof globalThis.pluginBridge==='undefined'&&typeof globalThis.require==='undefined'&&typeof process==='undefined')}}}})]}}`
  return {
    buildOptions: (await buildPackage({ root, outDir: directory })).backendOptions,
    entry: `
      import { compileUserModule } from ${JSON.stringify(path.join(root, 'src/backend/compiler.ts'))};
      import { createHarnessWorker } from ${JSON.stringify(path.join(root, 'src/backend/harness/workerRuntime.ts'))};
      export function register(api){const R=api.React;
        void compileUserModule('/fixture/provider.ts',{readText:async()=>"export function register(){const value: string='sandbox compiler';return value}"}).then(async result=>{const compiled=await import(result.url);const text=compiled.register();result.dispose();api.registerView('fixture.compiler',()=>R.createElement('div',{id:'compiler-result'},text))});
        void compileUserModule('/fixture/harness.ts',{readText:async()=>${JSON.stringify(harnessSource)}}).then(compiled=>{
          const worker=createHarnessWorker({mode:'run',url:compiled.url,harnessId:'fixture',caseId:'loop',target:{provider:'fixture',model:'fixture'},settings:{},maxTurns:3});
          worker.addEventListener('message',({data:message})=>{if(message.type==='host-call'){const turn=message.payload.turn;worker.postMessage({type:'host-result',id:message.id,value:{text:turn===1?'':'fern and moss',toolCalls:turn===1?[{id:'tool',name:'read_plants',arguments:{}}]:[],events:[],usage:{},latencyMs:0,cached:false}})}else if(message.type==='case-result'||message.type==='worker-error'){worker.terminate();compiled.dispose();api.registerView('fixture.harness',()=>R.createElement('div',{id:'harness-result'},JSON.stringify(message)))}})
        });
      }
    `,
    run: `
      for(let i=0;i<300;i++){
        for(const frame of win.webContents.mainFrame.framesInSubtree.filter(f=>f.url.endsWith('/surface.html'))){const text=await frame.executeJavaScript('document.querySelector("#compiler-result")?.textContent');if(text){report.compiler=text;break}}
        if(report.compiler)break;await wait(20)
      }
      if(!report.compiler)throw Error('Package TypeScript compiler did not run under sandbox CSP');
      for(let i=0;i<300;i++){
        for(const frame of win.webContents.mainFrame.framesInSubtree.filter(f=>f.url.endsWith('/surface.html'))){const text=await frame.executeJavaScript('document.querySelector("#harness-result")?.textContent');if(text){report.harness=JSON.parse(text);break}}
        if(report.harness)break;await wait(20)
      }
      if(!report.harness)throw Error('Package harness Worker did not finish under sandbox CSP');
    `,
    verify(result) {
      assert.equal(result.compiler, 'sandbox compiler')
      assert.equal(result.harness.type, 'case-result')
      assert.equal(result.harness.result.status, 'pass')
      assert.equal(result.harness.turns, 2)
      assert.equal(result.harness.result.metrics.transcript_messages, 4)
      assert.equal(result.harness.result.metrics.isolated, 1)
    }
  }
}
