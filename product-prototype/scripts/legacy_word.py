"""Read the main text story of unencrypted Word 97-2003 files.

Read-only CFB / Word piece-table extraction. No macros or embedded objects run.
Formatting, revision-state and page layout are intentionally not reconstructed.
"""
import struct
from pathlib import Path

def extract(path):
    data=Path(path).read_bytes()
    if data[:8]!=bytes.fromhex('D0CF11E0A1B11AE1'): raise ValueError('Not an OLE Word document')
    u16=lambda b,p:struct.unpack_from('<H',b,p)[0]
    u32=lambda b,p:struct.unpack_from('<I',b,p)[0]
    sector_size=1<<u16(data,30);mini_size=1<<u16(data,32)
    if sector_size not in (512,4096) or mini_size!=64: raise ValueError('Unsupported compound file geometry')
    def sector(sid):
        start=(sid+1)*sector_size
        if sid>=0xfffffff8 or start+sector_size>len(data): raise ValueError('Invalid sector address')
        return data[start:start+sector_size]
    fat_ids=[x for x in struct.unpack_from('<109I',data,76) if x<0xfffffff8]
    sid=u32(data,68)
    for _ in range(u32(data,72)):
        words=struct.unpack('<'+'I'*(sector_size//4),sector(sid))
        fat_ids.extend(x for x in words[:-1] if x<0xfffffff8);sid=words[-1]
    fat=[]
    for sid in fat_ids:fat.extend(struct.unpack('<'+'I'*(sector_size//4),sector(sid)))
    def chain(start,table,reader):
        result=[];seen=set();sid=start
        while sid<0xfffffff8:
            if sid in seen or sid>=len(table):raise ValueError('Corrupt sector chain')
            seen.add(sid);result.append(reader(sid));sid=table[sid]
        return b''.join(result)
    directory=chain(u32(data,48),fat,sector)
    streams={};root=None
    for offset in range(0,len(directory),128):
        item=directory[offset:offset+128]
        length=u16(item,64)
        if length<2 or length>64:continue
        name=item[:length-2].decode('utf-16le')
        record=(u32(item,116),struct.unpack_from('<Q',item,120)[0])
        if item[66]==5:root=record
        if item[66]==2:streams[name]=record
    mini_fat_data=chain(u32(data,60),fat,sector) if u32(data,64) else b''
    mini_fat=list(struct.unpack('<'+'I'*(len(mini_fat_data)//4),mini_fat_data))
    mini_stream=chain(root[0],fat,sector)[:root[1]] if root and root[1] else b''
    def read(name):
        sid,size=streams[name]
        if size<u32(data,56):return chain(sid,mini_fat,lambda s:mini_stream[s*mini_size:(s+1)*mini_size])[:size]
        return chain(sid,fat,sector)[:size]
    if 'EncryptedPackage' in streams:
        raise ValueError('Encrypted Office package; requires an unencrypted copy')
    if 'WordDocument' not in streams:
        raise ValueError('Not a classic Word text stream; entries: ' + ', '.join(streams))
    word=read('WordDocument');flags=u16(word,10)
    if flags&0x0100:raise ValueError('Encrypted Word document')
    table=read('1Table' if flags&0x0200 else '0Table')
    pos=32;pos+=2+u16(word,pos)*2
    lw=pos+2;ccp_text=u32(word,lw+12);pos+=2+u16(word,pos)*4
    count=u16(word,pos);pairs=pos+2
    if count<=33:raise ValueError('Unsupported FIB version')
    clx_offset=u32(word,pairs+33*8);clx_length=u32(word,pairs+33*8+4)
    clx=table[clx_offset:clx_offset+clx_length];pos=0
    while pos<len(clx) and clx[pos]==1:pos+=3+u16(clx,pos+1)
    if pos>=len(clx) or clx[pos]!=2:raise ValueError('Missing text piece table')
    length=u32(clx,pos+1);pieces=clx[pos+5:pos+5+length]
    if (length-4)%12:raise ValueError('Invalid piece table length')
    n=(length-4)//12;cps=struct.unpack_from('<'+'I'*(n+1),pieces,0)
    texts=[]
    for i in range(n):
        if cps[i]>=ccp_text:break
        length=min(cps[i+1],ccp_text)-cps[i]
        fc=u32(pieces,(n+1)*4+i*8+2);compressed=bool(fc&0x40000000);offset=fc&0x3fffffff
        if compressed:offset//=2;texts.append(word[offset:offset+length].decode('cp1252',errors='replace'))
        else:texts.append(word[offset:offset+length*2].decode('utf-16le',errors='replace'))
    return ''.join(texts)
