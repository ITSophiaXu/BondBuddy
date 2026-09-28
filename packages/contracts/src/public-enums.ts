/** Shared public market, offering and document-purpose values. */
export const MARKETS = ['sse', 'szse', 'nafmii'] as const;
export const OFFERINGS = ['private', 'public', 'public_all', 'ppn', 'mtn', 'cp', 'scp', 'dfi'] as const;
export const DOCUMENT_PURPOSES = ['registration', 'issuance'] as const;
export const MARKET_OFFERINGS = { sse: ['private', 'public', 'public_all'], szse: ['private', 'public', 'public_all'], nafmii: ['ppn', 'mtn', 'cp', 'scp', 'dfi'] } as const;
export const MARKET_LABELS = { sse: '上交所', szse: '深交所', nafmii: '交易商协会' } as const;
export const OFFERING_LABELS = { private: '普通私募公司债', public: '小公募', public_all: '大公募', ppn: 'PPN · 定向债务融资工具', mtn: 'MTN · 中期票据', cp: 'CP · 短期融资券', scp: 'SCP · 超短期融资券', dfi: 'DFI · 储架发行' } as const;
