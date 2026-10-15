export const failure=(code,message)=>Object.assign(new Error(message),{code});
export function cents(v){const s=String(v).trim();if(!/^-?\d+(\.\d{1,2})?$/.test(s))throw failure('INVALID_MONEY','金额格式或精度不支持。');const [a,b='']=s.replace('-','').split('.');return (s.startsWith('-')?-1n:1n)*(BigInt(a)*100n+BigInt(b.padEnd(2,'0')));}
export const yuan=v=>`${v<0n?'-':''}${(v<0n?-v:v)/100n}.${String((v<0n?-v:v)%100n).padStart(2,'0')}`;
