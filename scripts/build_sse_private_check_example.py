"""Explicit synthetic input for #15/#19 handoff; never publish these reviews."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
def e(value):
    return {'value':value,'status':'verified','anchors':['synthetic:v4:material-version-1:paragraph-7']}
def fields(**kwargs):
    return {key:e(value) for key,value in kwargs.items()}
def pair(key='本品种发行规模',current='5亿元',disclosed='5亿元'):
    return fields(key=key,current=current,disclosed=disclosed)

def build():
    data=json.loads((ROOT/'packages/domain/examples/sse-private-check-input-v3.json').read_text('utf8'))
    # The imported v3 example covers the two v3 additions, not the full v2 inventory.
    binding={'entityId':'synthetic-entity-1','scope':'consolidated','currency':'CNY','unit':'万元','periodStart':'2025-01-01','periodEnd':'2025-09-30'}
    data.update({
      'sourceSelection':{**fields(selected='100',completeCandidateInventory=True),'candidates':[{'value':e('100'),'applicable':e(True)}]},
      'evidenceUse':{'original':e('100'),**fields(publishedAsConfirmed=True,markedForConfirmation=False)},
      'identityComparison':fields(expected=binding,actual=binding),
      'currentTerm':{'value':pair(),**fields(trancheId='品种一',approvalRoute='private_listing')},
      'fundsSimulation':fields(included=True,simpleCashDebtOnly=True,comparable=True,assumptions='合成假设：到账、现金偿债，发行费用抵减债务初始账面金额；无税项、投资、后续摊销。',feeTreatment='deduct_debt',openingAssets='100',openingLiabilities='60',openingEquity='40',grossProceeds='10',expenses='1',debtRepayment='5',closingAssets='104',closingLiabilities='64',closingEquity='40'),
      'previousProceeds':fields(repeatApplication=True,total='0.3',used='0.1',balance='0.2',comparable=True,unrectifiedUnauthorizedUse=False,disclosureComplete=True),
      'businessSegment':fields(comparable=True,revenue='10',cost='8',grossProfit='2',totalRevenue='100',totalGrossProfit='20',grossMarginPercent='20.00',marginPlaces=2,operationsDisclosed=True,materialRisk=False),
      'indicator':fields(definition='合成流动比率：已核对流动资产/流动负债',comparable=True,numerator='100',denominator='30',disclosed='3.33',scale='ratio',decimalPlaces=2),
      'causeStatement':fields(cause='业务量增长导致收入增加',supportKind='business_evidence',support='合成业务量及价格说明',causalLinkReviewed=True,markedForConfirmation=False),
      'debtReconciliation':{**fields(comparable=True,completeInventory=True,total='100',statementTotal='95',differenceExplanation='合成调整：其他有息项目5'),'adjustments':[e('5')],'maturityBuckets':[e('30'),e('70')]},
      'creditFacility':fields(comparable=True,simpleAvailableEqualsTotalMinusUsed=True,total='100',used='40',available='60'),
      'ratingEnhancement':{**fields(rated=True,currentReport='合成本期评级报告',enhanced=True,currentContract='合成本期保证合同'),'rating':pair('主体评级','AA','AA'),'guarantee':pair('担保范围','本金及利息','本金及利息')},
      'protectionTerms':{**fields(trusteeAgreementPresent=True,meetingRulesPresent=True,referenceExampleAdded=True,actualAgreement='合成本期实际约定'),'term':pair('表决比例','2/3','2/3')},
      'riskUpdate':{**fields(historicalRiskRemoved=False),'fact':pair('有息债务','100万元','100万元')},
      'delivery':fields(artifactHash='a'*64,requiredSections=['terms','financial','risk'],deliveredSections=['terms','financial','risk'],exemptSections=[],hasHistory=True,contentChanged=True,revisionCount=3,commentsNeeded=True,commentCount=2,wpsOpenedAndReopened=False),
      'trusteeStatement':{**fields(statementKind='performed',supportKind='performance_record',actualSupport='合成履职记录'),'duty':pair('信用监测','按协议季度跟踪','按协议季度跟踪')},
      'governanceReview':fields(corporateEvents=['合成董事变更'],controlAndAppointmentsEvidence='合成控制链/任职记录',currentCompanyLawEvidence='合成公司法核对凭据',currentReorganizationDefinition='合成现行定义核对凭据',reorganizationAssessment='合成重组判断；非生产意见'),
      'contingentReview':{**fields(completeInventory=True,checkedThrough='2026-09-26',signingDate='2026-09-26'),'areas':[fields(area=k,observation='reviewed_absent',publishedAsAbsent=True,assessment='合成逐类排查记录') for k in ['related_parties','guarantees','litigation_arbitration','restricted_assets','subsequent_events']]},
      'focusReview':fields(completeFeatureReview=True,triggeredProfiles=['city_construction','group'],assessment='合成多项重点审核',blanketIssuanceBanClaimed=False),
      'specialReview':fields(completeFeatureReview=True,features=[],ordinaryPackOnly=True),
      'negativeListReview':fields(currentOfficialList='合成负面清单引用，非正式效力确认',issuerAssessment='合成发行人逐项判断',simultaneousSameInstrumentApplication=False,unusedPreviousSameInstrumentQuota=False,publicProfitThresholdUsedToReject=False),
      'optimizedReview':fields(requested=False),
    })
    path=ROOT/'packages/domain/examples/sse-private-check-input-v4.json'
    path.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n','utf8')

if __name__=='__main__':
    build()
