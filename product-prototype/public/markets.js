// Product taxonomy. DFI is a registration mode, not a debt instrument.
export const MARKETS=[['sse','上交所'],['szse','深交所'],['nafmii','交易商协会']];
export const EXCHANGE_OFFERINGS=[['private','普通私募公司债'],['public','小公募（面向专业投资者）'],['public_all','大公募（面向普通投资者）']];
export const BANK_OFFERINGS=[['ppn','PPN · 定向债务融资工具'],['mtn','MTN · 中期票据'],['cp','CP · 短期融资券'],['scp','SCP · 超短期融资券'],['abn','ABN · 资产支持票据'],['abcp','ABCP · 资产支持商业票据'],['prn','PRN · 项目收益票据'],['pn','PN · 永续票据']];
export const offeringsFor=market=>market==='nafmii'?BANK_OFFERINGS:EXCHANGE_OFFERINGS;
export const SCOPE_NAMES=Object.fromEntries(MARKETS.flatMap(([market,label])=>offeringsFor(market).map(([offering,name])=>[`${market}-${offering}`,`${label} · ${name}`])));
export const validScope=scope=>Object.hasOwn(SCOPE_NAMES,scope);
export const offeringName=(market,offering)=>offeringsFor(market).find(([id])=>id===offering)?.[1]||'待选择';
export const annualCountFor=offering=>['private','ppn'].includes(offering)?2:3;
