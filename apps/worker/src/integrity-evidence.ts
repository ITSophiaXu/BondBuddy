import {
  INTEGRITY_SITES,
  resolveIntegritySite,
  integritySourceAllowed,
  integrityQueryAllowed,
  integritySearchQueries,
  type IntegritySubject,
  type IntegrityRecord,
  type IntegrityProposal,
} from '@bondbuddy/contracts';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { verifiedSearchSources } from './review-public-stage.js';

export type IntegritySearchEvent = { observed_at: string; item: Record<string, unknown> };
// Only the provider's real search actions establish execution. Model prose and URLs do not.
export function integrityQueries(events: IntegritySearchEvent[]): string[] {
  return integritySearchQueries(events);
}
export function integrityRecords(
  subject: IntegritySubject,
  siteIds: string[],
  proposal: IntegrityProposal | null,
  events: IntegritySearchEvent[],
  time: string,
): IntegrityRecord[] {
  const verified = verifiedSearchSources(events),
    queries = integrityQueries(events);
  return siteIds.map((id) => {
    const site = resolveIntegritySite(
        INTEGRITY_SITES.find((s) => s.id === id)!,
        subject,
      ),
      urls = site.links.map((l) => l.url);
    const applicable = !(subject.kind === 'person' && site.companyOnly),
      entry = proposal?.sites.find((s) => s.site_id === id);
    const actual = queries.filter(
      (q) =>
        q.includes(subject.name) &&
        [...q.matchAll(/\bsite:([^\s"']+)/gi)].some((match) => {
          return integrityQueryAllowed(site, q, match[1]);
        }),
    );
    const sources = (entry?.sources ?? []).flatMap((s) => {
      const v = verified.get(s.url);
      if (
        !actual.length ||
        !v ||
        !integritySourceAllowed(site, s.url) ||
        !s.quote.trim() ||
        !v.text.includes(s.quote) ||
        !s.quote.includes(subject.name)
      )
        return [];
      return [
        {
          url: s.url,
          title: v.title.slice(0, 200),
          quote: s.quote,
          retrieved_at: v.time,
          tool_call_id: v.id,
          sha256: inputManifestHash({ url: s.url, text: v.text }),
        },
      ];
    });
    return {
      subject_id: subject.id,
      site_id: id,
      site_name: site.name,
      urls,
      query: actual.join('\n').slice(0, 4000),
      checked_at: time,
      status: !applicable
        ? 'not_applicable'
        : !urls.length
          ? 'needs_manual'
          : sources.length
            ? 'public_matches'
            : actual.length
              ? 'needs_manual'
              : 'query_failed',
      reason: !applicable
        ? '本网站仅支持企业核查。'
        : !urls.length
          ? '企业注册地尚未完整，需补充省份和城市后核对属地官网。'
          : sources.length
            ? '发现与名称匹配的公开来源，需核对主体身份、事项时点和全文；不代表已确认违法失信。'
            : actual.length
              ? '已执行官网域名公开搜索，未取得可确认的主体记录。请进入官网完成查询并补充证据；搜索无命中不等于无风险。'
              : '未取得本对象在该网站的真实查询记录，需人工进入官网查询并补充证据。',
      sources: applicable ? sources : [],
      search_performed: applicable && !!actual.length,
    };
  });
}
