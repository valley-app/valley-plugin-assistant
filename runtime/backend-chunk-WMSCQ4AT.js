import{B as p,C as o,c as n,j as c,s as u,t as m}from"./backend-chunk-BRZJN742.js";import{e as g}from"./backend-chunk-6KQM7YCD.js";var a=g(c(),1);function s(r,e,t=n()){return p(r,e,t)}function A(r,e,t=n()){return s(r,()=>o(r,e,t),t)}function S(r,e,t=n()){return s(r,async()=>{let i=JSON.stringify(e,null,2);await o(r,i,t)},t)}function v(r,e,t=n()){return e.length===0?Promise.resolve():s(r,async()=>{await m(a.default.dirname(r),{recursive:!0},t);let i=e.map(f=>JSON.stringify(f)).join(`
`)+`
`;await u(r,i,"utf8",t)},t)}export{s as a,A as b,S as c,v as d};
