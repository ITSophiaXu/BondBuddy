-- User-authorized commercial rule, 2026-11-11. This is not a C_plan model or a
-- complete-cost managed-price publication. Existing contracts stay immutable.
INSERT INTO bb_credit_price_versions(id,prices,effective_at,actor,reason,pricing_mode)
 SELECT 'bb-task-price-scope-20261111-v4',prices,clock_timestamp(),'commercial-rule-migration',
 'Authorized commercial integrity rule: base 2000 + 85 per executable subject/official-section pair, cap 22738; settle verified successful pairs. Planning cost unknown. Other v3 SKUs unchanged.','outcome_cny_v1'
 FROM bb_credit_price_versions WHERE id='bb-task-price-170-20261029-v3';
CREATE TABLE bb_integrity_commercial_rules(
 price_version text PRIMARY KEY REFERENCES bb_credit_price_versions(id),base_points bigint NOT NULL,pair_points bigint NOT NULL,cap_points bigint NOT NULL,
 planned_cost_cny numeric,authority text NOT NULL,rule jsonb NOT NULL
);
INSERT INTO bb_integrity_commercial_rules VALUES('bb-task-price-scope-20261111-v4',2000,85,22738,NULL,'User-authorized commercial standard 2026-11-11',
 '{"unit":"distinct executable subject x official website section","zero_results":"valid successful query","all_failed_points":0,"retry_and_pagination_points":0,"same_round_reexport_points":0}');
CREATE TRIGGER bb_integrity_commercial_rules_frozen BEFORE UPDATE OR DELETE ON bb_integrity_commercial_rules FOR EACH ROW EXECUTE FUNCTION bb_credit_immutable();
CREATE OR REPLACE FUNCTION bb_is_automatic_price_version(v text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT v IN ('bb-task-price-170-20261029-v2','bb-task-price-170-20261029-v3','bb-task-price-scope-20261111-v4') OR v~'^bb-task-price-managed-[a-f0-9]{32}$'
$$;
DO $$ DECLARE definition text; marker text:='p.id IN (''bb-task-price-170-20261029-v2'',''bb-task-price-170-20261029-v3'')'; BEGIN
 SELECT pg_get_functiondef('bb_automatic_scope_price_guard()'::regprocedure) INTO definition;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Automatic publication guard anchor changed'; END IF;
 EXECUTE replace(definition,marker,'p.id IN (''bb-task-price-170-20261029-v2'',''bb-task-price-170-20261029-v3'',''bb-task-price-scope-20261111-v4'')');
END $$;

-- Release-frozen website applicability and regional resolution facts. These
-- contain no tariffs or costs and also reconstruct authentic older manifests.
CREATE TABLE bb_integrity_billing_catalog(site_id text PRIMARY KEY,rule jsonb NOT NULL);
CREATE TABLE bb_integrity_billing_regions(name text PRIMARY KEY,rule jsonb NOT NULL);
INSERT INTO bb_integrity_billing_catalog VALUES
('credit-china','{"company_only":false,"urls":["https://www.creditchina.gov.cn/"],"query_terms":[]}'::jsonb),
('execution-dishonest','{"company_only":false,"urls":["https://zxgk.court.gov.cn/shixin/"],"query_terms":["失信"]}'::jsonb),
('execution-debtor','{"company_only":false,"urls":["https://zxgk.court.gov.cn/zhixing/"],"query_terms":["被执行人信息"]}'::jsonb),
('execution-restriction','{"company_only":false,"urls":["https://zxgk.court.gov.cn/xgl/"],"query_terms":["限制消费","限高"]}'::jsonb),
('bankruptcy','{"company_only":true,"urls":["https://pccz.court.gov.cn/"],"query_terms":[]}'::jsonb),
('tax','{"company_only":false,"urls":["https://www.chinatax.gov.cn/"],"query_terms":[]}'::jsonb),
('tax-dishonest','{"company_only":false,"urls":["https://www.chinatax.gov.cn/"],"query_terms":["重大税收违法","税收违法失信"]}'::jsonb),
('industry-credit','{"company_only":true,"urls":["https://www.bcp12312.org.cn/"],"query_terms":[]}'::jsonb),
('pbc','{"company_only":false,"urls":["https://www.pbc.gov.cn/"],"query_terms":[]}'::jsonb),
('nfra','{"company_only":false,"urls":["https://www.nfra.gov.cn/"],"query_terms":[]}'::jsonb),
('csrc-portal','{"company_only":false,"urls":["https://www.csrc.gov.cn/"],"query_terms":[]}'::jsonb),
('csrc','{"company_only":false,"urls":["https://neris.csrc.gov.cn/shixinchaxun/"],"query_terms":[]}'::jsonb),
('sse','{"company_only":false,"urls":["https://www.sse.com.cn/"],"query_terms":[]}'::jsonb),
('bse','{"company_only":false,"urls":["https://www.bse.cn/"],"query_terms":[]}'::jsonb),
('szse','{"company_only":false,"urls":["https://www.szse.cn/"],"query_terms":[]}'::jsonb),
('szse-bond-discipline','{"company_only":false,"urls":["https://www.szse.cn/"],"query_terms":["债券纪律处分","债券 纪律处分"]}'::jsonb),
('szse-supervision','{"company_only":false,"urls":["https://www.szse.cn/"],"query_terms":["监管措施"]}'::jsonb),
('safe','{"company_only":false,"urls":["https://www.safe.gov.cn/"],"query_terms":[]}'::jsonb),
('neeq','{"company_only":false,"urls":["https://www.neeq.com.cn/"],"query_terms":[]}'::jsonb),
('nafmii-discipline','{"company_only":false,"urls":["https://www.nafmii.org.cn/"],"query_terms":["自律处分"]}'::jsonb),
('sac','{"company_only":false,"urls":["https://www.sac.net.cn/"],"query_terms":[]}'::jsonb),
('amac','{"company_only":false,"urls":["https://www.amac.org.cn/"],"query_terms":[]}'::jsonb),
('mofcom','{"company_only":false,"urls":["https://www.mofcom.gov.cn/"],"query_terms":[]}'::jsonb),
('commerce-credit','{"company_only":true,"urls":["https://www.bcpcn.com/"],"query_terms":[]}'::jsonb),
('cfa-credit','{"company_only":true,"urls":["https://www.cfachina.org/"],"query_terms":["诚信记录"]}'::jsonb),
('cfa-discipline','{"company_only":false,"urls":["https://www.cfachina.org/"],"query_terms":["纪律惩戒","纪律处分"]}'::jsonb),
('emergency','{"company_only":false,"urls":["https://www.mem.gov.cn/"],"query_terms":[]}'::jsonb),
('ndrc','{"company_only":false,"urls":["https://www.ndrc.gov.cn/"],"query_terms":[]}'::jsonb),
('environment','{"company_only":false,"urls":["https://www.mee.gov.cn/"],"query_terms":[]}'::jsonb),
('mof','{"company_only":false,"urls":["https://www.mof.gov.cn/"],"query_terms":[]}'::jsonb),
('statistics','{"company_only":false,"urls":["https://www.stats.gov.cn/"],"query_terms":[]}'::jsonb),
('customs','{"company_only":false,"urls":["http://www.customs.gov.cn/"],"query_terms":[]}'::jsonb),
('industry','{"company_only":false,"urls":["https://www.miit.gov.cn/"],"query_terms":[]}'::jsonb),
('samr','{"company_only":false,"urls":["https://www.samr.gov.cn/"],"query_terms":[]}'::jsonb),
('samr-penalties','{"company_only":false,"urls":["https://www.samr.gov.cn/"],"query_terms":["行政处罚文书"]}'::jsonb),
('agriculture','{"company_only":false,"urls":["https://www.moa.gov.cn/"],"query_terms":[]}'::jsonb),
('customs-credit','{"company_only":true,"urls":["http://credit.customs.gov.cn/"],"query_terms":[]}'::jsonb),
('energy','{"company_only":false,"urls":["https://www.nea.gov.cn/"],"query_terms":[]}'::jsonb),
('housing','{"company_only":false,"urls":["https://www.mohurd.gov.cn/"],"query_terms":[]}'::jsonb),
('cec-blacklist','{"company_only":true,"urls":["https://www.cec.org.cn/"],"query_terms":["关联黑名单","黑名单"]}'::jsonb),
('cec-supervision','{"company_only":true,"urls":["https://www.cec.org.cn/"],"query_terms":["监管","大数据预警"]}'::jsonb),
('resources','{"company_only":false,"urls":["https://www.mnr.gov.cn/"],"query_terms":[]}'::jsonb),
('mohrss','{"company_only":false,"urls":["https://www.mohrss.gov.cn/"],"query_terms":[]}'::jsonb),
('transport','{"company_only":false,"urls":["https://www.mot.gov.cn/"],"query_terms":[]}'::jsonb),
('transport-credit','{"company_only":false,"urls":["https://credit.mot.gov.cn/"],"query_terms":["信用信息"]}'::jsonb),
('transport-penalties','{"company_only":false,"urls":["https://credit.mot.gov.cn/"],"query_terms":["行政处罚"]}'::jsonb),
('construction-credit','{"company_only":false,"urls":["https://jzsc.mohurd.gov.cn/"],"query_terms":[]}'::jsonb),
('salt-credit','{"company_only":true,"urls":["https://www.cnsalt.cn/"],"query_terms":["信用盐业","信用"]}'::jsonb),
('procurement-agency','{"company_only":true,"urls":["https://www.ccgp.gov.cn/"],"query_terms":["代理机构不良行为"]}'::jsonb),
('procurement-dishonest','{"company_only":true,"urls":["https://www.ccgp.gov.cn/"],"query_terms":["严重违法失信"]}'::jsonb),
('salt-association','{"company_only":false,"urls":["https://www.cnsalt.cn/"],"query_terms":[]}'::jsonb),
('nmpa','{"company_only":false,"urls":["https://www.nmpa.gov.cn/"],"query_terms":[]}'::jsonb),
('local-csrc','{"company_only":true,"urls":["https://www.csrc.gov.cn/"],"query_terms":[]}'::jsonb),
('local-tax','{"company_only":true,"urls":["https://www.chinatax.gov.cn/"],"query_terms":[]}'::jsonb),
('gsxt','{"company_only":true,"urls":["https://www.gsxt.gov.cn/"],"query_terms":[]}'::jsonb),
('execution','{"company_only":false,"urls":["https://zxgk.court.gov.cn/"],"query_terms":[]}'::jsonb),
('judgments','{"company_only":false,"urls":["https://wenshu.court.gov.cn/"],"query_terms":[]}'::jsonb),
('food-drug','{"company_only":false,"urls":["https://www.samr.gov.cn/","https://www.nmpa.gov.cn/"],"query_terms":[]}'::jsonb);
INSERT INTO bb_integrity_billing_regions VALUES
('北京','{"name":"北京","csrc":"https://www.csrc.gov.cn/beijing/index.shtml","tax":"http://beijing.chinatax.gov.cn/"}'::jsonb),
('天津','{"name":"天津","csrc":"https://www.csrc.gov.cn/tianjin/index.shtml","tax":"http://tianjin.chinatax.gov.cn/"}'::jsonb),
('河北','{"name":"河北","csrc":"https://www.csrc.gov.cn/hebei/index.shtml","tax":"http://hebei.chinatax.gov.cn/"}'::jsonb),
('山西','{"name":"山西","csrc":"https://www.csrc.gov.cn/shanxi/index.shtml","tax":"http://shanxi.chinatax.gov.cn/"}'::jsonb),
('内蒙古','{"name":"内蒙古","csrc":"https://www.csrc.gov.cn/neimenggu/index.shtml","tax":"http://neimenggu.chinatax.gov.cn/"}'::jsonb),
('辽宁','{"name":"辽宁","csrc":"https://www.csrc.gov.cn/liaoning/index.shtml","tax":"http://liaoning.chinatax.gov.cn/"}'::jsonb),
('吉林','{"name":"吉林","csrc":"https://www.csrc.gov.cn/jilin/index.shtml","tax":"http://jilin.chinatax.gov.cn/"}'::jsonb),
('黑龙江','{"name":"黑龙江","csrc":"https://www.csrc.gov.cn/heilongjiang/index.shtml","tax":"http://heilongjiang.chinatax.gov.cn/"}'::jsonb),
('上海','{"name":"上海","csrc":"https://www.csrc.gov.cn/shanghai/index.shtml","tax":"http://shanghai.chinatax.gov.cn/"}'::jsonb),
('江苏','{"name":"江苏","csrc":"https://www.csrc.gov.cn/jiangsu/index.shtml","tax":"http://jiangsu.chinatax.gov.cn/"}'::jsonb),
('浙江','{"name":"浙江","csrc":"https://www.csrc.gov.cn/zhejiang/index.shtml","tax":"http://zhejiang.chinatax.gov.cn/"}'::jsonb),
('安徽','{"name":"安徽","csrc":"https://www.csrc.gov.cn/anhui/index.shtml","tax":"http://anhui.chinatax.gov.cn/"}'::jsonb),
('福建','{"name":"福建","csrc":"https://www.csrc.gov.cn/fujian/index.shtml","tax":"http://fujian.chinatax.gov.cn/"}'::jsonb),
('江西','{"name":"江西","csrc":"https://www.csrc.gov.cn/jiangxi/index.shtml","tax":"http://jiangxi.chinatax.gov.cn/"}'::jsonb),
('山东','{"name":"山东","csrc":"https://www.csrc.gov.cn/shandong/index.shtml","tax":"http://shandong.chinatax.gov.cn/"}'::jsonb),
('河南','{"name":"河南","csrc":"https://www.csrc.gov.cn/henan/index.shtml","tax":"https://henan.chinatax.gov.cn/"}'::jsonb),
('湖北','{"name":"湖北","csrc":"https://www.csrc.gov.cn/hubei/index.shtml","tax":"http://hubei.chinatax.gov.cn/"}'::jsonb),
('湖南','{"name":"湖南","csrc":"https://www.csrc.gov.cn/hunan/index.shtml","tax":"http://hunan.chinatax.gov.cn/"}'::jsonb),
('广东','{"name":"广东","csrc":"https://www.csrc.gov.cn/guangdong/index.shtml","tax":"http://guangdong.chinatax.gov.cn/"}'::jsonb),
('广西','{"name":"广西","csrc":"https://www.csrc.gov.cn/guangxi/index.shtml","tax":"https://guangxi.chinatax.gov.cn/"}'::jsonb),
('海南','{"name":"海南","csrc":"https://www.csrc.gov.cn/hainan/index.shtml","tax":"http://hainan.chinatax.gov.cn/"}'::jsonb),
('重庆','{"name":"重庆","csrc":"https://www.csrc.gov.cn/chongqing/index.shtml","tax":"http://chongqing.chinatax.gov.cn/"}'::jsonb),
('四川','{"name":"四川","csrc":"https://www.csrc.gov.cn/sichuan/index.shtml","tax":"http://sichuan.chinatax.gov.cn/"}'::jsonb),
('贵州','{"name":"贵州","csrc":"https://www.csrc.gov.cn/guizhou/index.shtml","tax":"http://guizhou.chinatax.gov.cn/"}'::jsonb),
('云南','{"name":"云南","csrc":"https://www.csrc.gov.cn/yunnan/index.shtml","tax":"http://yunnan.chinatax.gov.cn/"}'::jsonb),
('西藏','{"name":"西藏","csrc":"https://www.csrc.gov.cn/xizang/index.shtml","tax":"https://xizang.chinatax.gov.cn/"}'::jsonb),
('陕西','{"name":"陕西","csrc":"https://www.csrc.gov.cn/shaanxi/index.shtml","tax":"https://shaanxi.chinatax.gov.cn/"}'::jsonb),
('甘肃','{"name":"甘肃","csrc":"https://www.csrc.gov.cn/gansu/index.shtml","tax":"http://gansu.chinatax.gov.cn/"}'::jsonb),
('青海','{"name":"青海","csrc":"https://www.csrc.gov.cn/qinghai/index.shtml","tax":"http://qinghai.chinatax.gov.cn/"}'::jsonb),
('宁夏','{"name":"宁夏","csrc":"https://www.csrc.gov.cn/ningxia/index.shtml","tax":"http://ningxia.chinatax.gov.cn/"}'::jsonb),
('新疆','{"name":"新疆","csrc":"https://www.csrc.gov.cn/xinjiang/index.shtml","tax":"https://xinjiang.chinatax.gov.cn/"}'::jsonb),
('深圳','{"name":"深圳","csrc":"https://www.csrc.gov.cn/shenzhen/index.shtml","tax":"https://shenzhen.chinatax.gov.cn/"}'::jsonb),
('大连','{"name":"大连","csrc":"https://www.csrc.gov.cn/dalian/index.shtml","tax":"http://dalian.chinatax.gov.cn/"}'::jsonb),
('宁波','{"name":"宁波","csrc":"https://www.csrc.gov.cn/ningbo/index.shtml","tax":"http://ningbo.chinatax.gov.cn/"}'::jsonb),
('厦门','{"name":"厦门","csrc":"https://www.csrc.gov.cn/xiamen/index.shtml","tax":"http://xiamen.chinatax.gov.cn/"}'::jsonb),
('青岛','{"name":"青岛","csrc":"https://www.csrc.gov.cn/qingdao/index.shtml","tax":"http://qingdao.chinatax.gov.cn/"}'::jsonb);
CREATE TRIGGER bb_integrity_billing_catalog_frozen BEFORE UPDATE OR DELETE ON bb_integrity_billing_catalog FOR EACH ROW EXECUTE FUNCTION bb_credit_immutable();
CREATE TRIGGER bb_integrity_billing_regions_frozen BEFORE UPDATE OR DELETE ON bb_integrity_billing_regions FOR EACH ROW EXECUTE FUNCTION bb_credit_immutable();

CREATE FUNCTION bb_integrity_region_normalize(value text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT regexp_replace(btrim(coalesce(value,'')),'(省|市|壮族自治区|回族自治区|维吾尔自治区|自治区)$','')
$$;
CREATE FUNCTION bb_integrity_query_scope_pairs(draft jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $$
 WITH subjects AS(SELECT s,bb_integrity_region_normalize(s->>'province') province,bb_integrity_region_normalize(s->>'city') city FROM jsonb_array_elements(draft->'subjects') s),
 normalized AS(SELECT s,city,CASE WHEN province<>'' THEN province WHEN s->>'kind'<>'company' THEN '' ELSE coalesce((
  SELECT r.name FROM bb_integrity_billing_regions r WHERE r.name NOT IN ('深圳','厦门','宁波','青岛','大连')
  AND (starts_with(regexp_replace(btrim(s->>'name'),'^[（(]',''),r.name) OR city=r.name) ORDER BY length(r.name) DESC LIMIT 1),
  CASE city WHEN '深圳' THEN '广东' WHEN '厦门' THEN '福建' WHEN '宁波' THEN '浙江' WHEN '青岛' THEN '山东' WHEN '大连' THEN '辽宁' ELSE '' END) END province FROM subjects),
 scoped AS(SELECT s,site_id,rule,CASE
  WHEN site_id NOT LIKE 'local-%' THEN rule->'urls'
  WHEN city='' AND province IN ('广东','福建','浙江','山东','辽宁') THEN '[]'::jsonb
  WHEN city IN ('深圳','厦门','宁波','青岛','大连') AND province IS DISTINCT FROM CASE city WHEN '深圳' THEN '广东' WHEN '厦门' THEN '福建' WHEN '宁波' THEN '浙江' WHEN '青岛' THEN '山东' WHEN '大连' THEN '辽宁' END THEN '[]'::jsonb
  ELSE coalesce((SELECT jsonb_build_array(r.rule->>CASE WHEN site_id='local-csrc' THEN 'csrc' ELSE 'tax' END) FROM bb_integrity_billing_regions r
   WHERE r.name=CASE WHEN city IN ('深圳','厦门','宁波','青岛','大连') THEN city ELSE province END),'[]'::jsonb) END urls
  FROM normalized CROSS JOIN LATERAL jsonb_array_elements_text(draft->'site_ids') chosen(site_id) JOIN bb_integrity_billing_catalog catalog USING(site_id)
  WHERE NOT(s->>'kind'='person' AND rule->>'company_only'='true'))
 SELECT coalesce(jsonb_agg(jsonb_build_object('subject_id',s->>'id','subject_name',s->>'name','site_id',site_id,'urls',urls,'query_terms',rule->'query_terms')) FILTER(WHERE jsonb_array_length(urls)>0),'[]'::jsonb) FROM scoped
$$;

-- Canonical JSON matches browser collection payloads: object keys are ASCII,
-- numeric fields are integer timing/page/size measurements, arrays retain order.
CREATE FUNCTION bb_integrity_browser_canonical(value jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE result text; BEGIN
 IF jsonb_typeof(value)='object' THEN SELECT '{'||coalesce(string_agg(to_jsonb(key)::text||':'||bb_integrity_browser_canonical(v),',' ORDER BY key COLLATE "C"),'')||'}' INTO result FROM jsonb_each(value) e(key,v); RETURN result; END IF;
 IF jsonb_typeof(value)='array' THEN SELECT '['||coalesce(string_agg(bb_integrity_browser_canonical(v),',' ORDER BY n),'')||']' INTO result FROM jsonb_array_elements(value) WITH ORDINALITY e(v,n); RETURN result; END IF;
 IF jsonb_typeof(value)='number' AND (abs((value::text)::numeric)>=1e21 OR (abs((value::text)::numeric)>0 AND abs((value::text)::numeric)<1e-6)) THEN
  RETURN regexp_replace(((value::text)::double precision)::text,'e([+-])0+([0-9])','e\1\2');
 END IF;
 RETURN value::text;
END $$;
CREATE FUNCTION bb_integrity_observed_time_valid(value text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$ BEGIN
 IF value IS NULL OR value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$'
  OR substring(value FROM 1 FOR 4)::integer<1 OR substring(value FROM 12 FOR 2)::integer>23
  OR substring(value FROM 15 FOR 2)::integer>59 OR substring(value FROM 18 FOR 2)::integer>59 THEN RETURN false; END IF;
 PERFORM value::timestamptz;RETURN true;
 EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE FUNCTION bb_integrity_query_scope_allowed(pair jsonb,query_text text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT position(pair->>'subject_name' IN query_text)>0 AND EXISTS(
  SELECT 1 FROM regexp_matches(query_text,'\msite:([^\s"'']+)','gi') scope,
  LATERAL(SELECT lower(split_part(regexp_replace(scope[1],'[/?#].*$',''),':',1)) host,
   CASE WHEN position('/' IN scope[1])=0 THEN '/' ELSE regexp_replace(substring(scope[1] FROM position('/' IN scope[1])),'[?#].*$','') END path) scoped,
  jsonb_array_elements_text(pair->'urls') portal(url)
  WHERE scope[1] !~ '[@:]' AND scoped.host=lower(regexp_replace(regexp_replace(portal.url,'^https?://',''),'[/?#].*$',''))
  AND (CASE WHEN pair->>'site_id'='local-csrc' THEN starts_with(scoped.path,regexp_replace(regexp_replace(portal.url,'^https?://[^/]+',''),'index\.shtml$',''))
   ELSE jsonb_array_length(pair->'query_terms')=0
    OR (regexp_replace(portal.url,'^https?://[^/]+','')<>'/' AND starts_with(scoped.path,regexp_replace(portal.url,'^https?://[^/]+','')))
    OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(pair->'query_terms') term WHERE position(regexp_replace(term,'\s','','g') IN regexp_replace(query_text,'\s','','g'))>0) END)
 )
$$;

-- Tighten the shared evidence predicate for all prices. Distinct-pair charging
-- below is enabled only by the explicit v4 quote, never by the current tariff.
CREATE OR REPLACE FUNCTION bb_integrity_query_evidence_ready(owner_id text,target_run text,records jsonb)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(
  SELECT 1 FROM bb_integrity_runs i
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(i.manifest->'scope_measurement'->'executable_query_pairs')='array'
    THEN i.manifest->'scope_measurement'->'executable_query_pairs' ELSE bb_integrity_query_scope_pairs(i.manifest->'draft') END) pair
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(records,'[]'::jsonb)) rec
  WHERE i.owner_user_id=owner_id AND i.run_id=target_run AND pair->>'subject_id'=rec->>'subject_id' AND pair->>'site_id'=rec->>'site_id'
  AND rec->'search_performed'='true'::jsonb AND length(btrim(coalesce(rec->>'query','')))>0
  AND rec->>'status' IN ('public_matches','no_public_results','needs_manual')
  AND ((jsonb_typeof(rec->'browser')='object' AND rec->'browser'->>'outcome' IN ('results','no_results') AND rec->>'status' IN ('public_matches','no_public_results')
   AND (rec->'browser'->'diagnostic' IS NULL OR rec->'browser'->'diagnostic'->>'code' IN ('results','no_results'))
   AND EXISTS(SELECT 1 FROM bb_integrity_browser_batches b JOIN bb_integrity_browser_captures c
    ON c.owner_user_id=b.owner_user_id AND c.run_id=b.run_id AND c.subject_id=b.subject_id AND c.site_id=b.site_id
    WHERE b.owner_user_id=owner_id AND b.run_id=target_run AND b.subject_id=rec->>'subject_id' AND b.site_id=rec->>'site_id'
    AND encode(sha256(convert_to(bb_integrity_browser_canonical(b.payload),'UTF8')),'hex')=trim(b.sha256)
    AND b.payload->'search_performed'='true'::jsonb AND b.payload->>'query'=rec->>'query' AND b.payload->>'outcome'=rec->'browser'->>'outcome'
    AND c.metadata->>'kind'='result' AND rec->'browser'->'captures' @> jsonb_build_array(c.metadata)
    AND b.payload->'captures' @> jsonb_build_array(jsonb_build_object('metadata',c.metadata))))
   OR (NOT rec ? 'browser' AND EXISTS(
    SELECT 1 FROM bb_model_web_search_evidence evidence CROSS JOIN LATERAL jsonb_array_elements(evidence.events) event
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(event->'item'->'action'->'queries')='array' THEN event->'item'->'action'->'queries' ELSE '[]'::jsonb END
     ||CASE WHEN jsonb_typeof(event->'item'->'action'->'query')='string' THEN jsonb_build_array(event->'item'->'action'->'query') ELSE '[]'::jsonb END) query
    WHERE evidence.owner_user_id=owner_id AND evidence.run_id=target_run AND event->'item'->>'type'='web_search' AND jsonb_typeof(event->'item'->'id')='string' AND length(event->'item'->>'id')>0
     AND encode(sha256(convert_to(bb_integrity_browser_canonical(evidence.events),'UTF8')),'hex')=trim(evidence.content_sha256)
     AND jsonb_typeof(event->'observed_at')='string' AND bb_integrity_observed_time_valid(event->>'observed_at') AND (NOT (event->'item' ? 'status') OR event->'item'->>'status'='completed')
     AND (NOT (event->'item'->'action' ? 'type') OR event->'item'->'action'->>'type'='search')
     AND jsonb_typeof(query)='string' AND (query #>> '{}')=ANY(regexp_split_to_array(rec->>'query',E'\n')) AND bb_integrity_query_scope_allowed(pair,query #>> '{}')
   )))
 );
$$;
CREATE FUNCTION bb_integrity_verified_query_pair_count(owner_id text,target_run text,records jsonb)
RETURNS integer LANGUAGE sql STABLE AS $$
 SELECT count(DISTINCT jsonb_build_array(rec->>'subject_id',rec->>'site_id'))::integer
 FROM jsonb_array_elements(coalesce(records,'[]'::jsonb)) rec
 WHERE bb_integrity_query_evidence_ready(owner_id,target_run,jsonb_build_array(rec))
$$;
