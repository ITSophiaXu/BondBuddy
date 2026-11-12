import assert from 'node:assert/strict';
import test from 'node:test';
import {requiresQuestionList} from './qa-question-scope.js';

test('one data-check answer and the difference of that comparison remain one deliverable',()=>{
  for(const content of [
    '请核对本期收入数据并回答问询。',
    '请核对本期收入数据，同时回复该问询。',
    '比较两期资产负债率，并计算差额',
    '对比两年流动比率，并计算差值。',
    '请比较两期营业收入，并计算两期的差额',
    '请核对本期收入数据并回答问询，并给出依据。',
  ])assert.equal(requiresQuestionList(content),false,content);
});

test('a continuation naming a different business target remains a separate question',()=>{
  for(const content of [
    '请核对本期收入数据并回答现金流问询。',
    '请核对本期收入数据并回答问询，另行分析现金流。',
    '比较两期资产负债率，并计算偿债缺口',
    '比较两期资产负债率，并计算收入差额',
    '比较两期资产负债率，并计算差额，并分析现金流',
    '请说明收入增长原因，并计算差额',
    '请分析收入变化，并回答问询',
    '比较两期资产负债率。现金流方面，计算差额。',
    '核对本期收入数据。关于现金流，回答本次问询。',
    '1. 比较两期资产负债率\n2. 计算差额',
    '资产负债率是多少；流动比率是多少',
    '请计算资产负债率，步骤如下：\n1. 核对负债总额\n2. 流动比率是多少',
  ])assert.equal(requiresQuestionList(content),true,content);
});

test('existing calculation evidence and support steps remain included without hiding new questions',()=>{
  for(const content of [
    '请说明收入增长原因，并说明依据',
    '请计算资产负债率，并解释计算方法',
    '请计算资产负债率，步骤如下：\n1. 核对负债总额\n2. 核对资产总额',
  ])assert.equal(requiresQuestionList(content),false,content);
});
