import {expect,type Page} from '@playwright/test';
import type {M4DocumentType} from '@bondbuddy/contracts';
export const documentChoice=(page:Page,type:M4DocumentType)=>page.locator('select[data-pf-document="'+type+'"]');
export const selectedRows=(page:Page)=>page.locator('select[data-pf-document]:not([data-pf-document=""])').evaluateAll(nodes=>nodes.map(node=>(node as HTMLSelectElement).value));
export async function clearRows(page:Page){while(await page.locator('[data-pf-remove]:not([data-pf-remove=""])').count())await page.locator('[data-pf-remove]:not([data-pf-remove=""])').last().click();}
export async function addDocuments(page:Page,types:M4DocumentType[]){for(const type of types){if(await documentChoice(page,type).count())continue;const blank=page.locator('select[data-pf-document=""]');if(!await blank.count())await page.locator('#pf-add-row').click();await blank.selectOption(type);await expect(documentChoice(page,type)).toHaveValue(type);}}
