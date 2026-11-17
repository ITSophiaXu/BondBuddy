/** Verified public endpoints for NEW checks only. Historical metadata is preserved.
 * Evidence: docs/acceptance/integrity-site-sweep-20261116.json;
 * latest retest: docs/acceptance/integrity-business-20261117.md.
 * A reachable homepage or an unconfirmed query is insufficient for this allowlist. */
export const INTEGRITY_AVAILABILITY_CHECKED_AT = '2026-11-17';
export const INTEGRITY_VERIFIED_ENDPOINTS: Readonly<Record<string, readonly string[]>> = {
  "bankruptcy": [
    "https://pccz.court.gov.cn/"
  ],
  "pbc": [
    "https://www.pbc.gov.cn/"
  ],
  "sse": [
    "https://www.sse.com.cn/"
  ],
  "bse": [
    "https://www.bse.cn/"
  ],
  "neeq": [
    "https://www.neeq.com.cn/"
  ],
  "nafmii-discipline": [
    "https://www.nafmii.org.cn/"
  ],
  "mohrss": [
    "https://www.mohrss.gov.cn/"
  ],
  "local-csrc": [
    "https://www.csrc.gov.cn/beijing/index.shtml",
    "https://www.csrc.gov.cn/tianjin/index.shtml",
    "https://www.csrc.gov.cn/hebei/index.shtml",
    "https://www.csrc.gov.cn/shanxi/index.shtml",
    "https://www.csrc.gov.cn/neimenggu/index.shtml",
    "https://www.csrc.gov.cn/liaoning/index.shtml",
    "https://www.csrc.gov.cn/jilin/index.shtml",
    "https://www.csrc.gov.cn/heilongjiang/index.shtml",
    "https://www.csrc.gov.cn/shanghai/index.shtml",
    "https://www.csrc.gov.cn/jiangsu/index.shtml",
    "https://www.csrc.gov.cn/zhejiang/index.shtml",
    "https://www.csrc.gov.cn/anhui/index.shtml",
    "https://www.csrc.gov.cn/fujian/index.shtml",
    "https://www.csrc.gov.cn/jiangxi/index.shtml",
    "https://www.csrc.gov.cn/henan/index.shtml",
    "https://www.csrc.gov.cn/hubei/index.shtml",
    "https://www.csrc.gov.cn/hunan/index.shtml",
    "https://www.csrc.gov.cn/guangdong/index.shtml",
    "https://www.csrc.gov.cn/guangxi/index.shtml",
    "https://www.csrc.gov.cn/hainan/index.shtml",
    "https://www.csrc.gov.cn/chongqing/index.shtml",
    "https://www.csrc.gov.cn/sichuan/index.shtml",
    "https://www.csrc.gov.cn/guizhou/index.shtml",
    "https://www.csrc.gov.cn/yunnan/index.shtml",
    "https://www.csrc.gov.cn/xizang/index.shtml",
    "https://www.csrc.gov.cn/shaanxi/index.shtml",
    "https://www.csrc.gov.cn/gansu/index.shtml",
    "https://www.csrc.gov.cn/qinghai/index.shtml",
    "https://www.csrc.gov.cn/ningxia/index.shtml",
    "https://www.csrc.gov.cn/xinjiang/index.shtml",
    "https://www.csrc.gov.cn/shenzhen/index.shtml",
    "https://www.csrc.gov.cn/dalian/index.shtml",
    "https://www.csrc.gov.cn/ningbo/index.shtml",
    "https://www.csrc.gov.cn/xiamen/index.shtml",
    "https://www.csrc.gov.cn/qingdao/index.shtml"
  ],
  "local-tax": [
    "http://shanxi.chinatax.gov.cn/",
    "http://guangdong.chinatax.gov.cn/"
  ]
};
