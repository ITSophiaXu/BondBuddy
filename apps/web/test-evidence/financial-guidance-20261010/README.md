# #642 财务材料上传提示

代码及原型基准：`6b4332de2d86c7df053a13cd05bcf6e908ac33a7`，Windows / Node 22 / Edge，合成项目信息（synthetic）。

- `npm run build`、`npm run check:contracts` 通过。
- `npm run test:unit -w @bondbuddy/web`：90 pass、0 fail、0 skip。
- Playwright `prototype-corrections.spec.ts --grep financial`：3 pass。覆盖桌面/手机、修改市场与跨年期间后保存重进、缺项/无效输入及上传可用。
- `financial-guidance-prototype.spec.ts`：1 pass，直接渲染原型模块。初次原型语法错误已修复，复验通过。

`implementation-1440/390.png` 与 `prototype-1440/390.png` 来自同尺寸视口（1440×960 / 390×844）的审计上传分区。为专门比较提示，原型截图隐藏了分区外固定操作栏；不改变原型产品行为。人工核对提示位置在上传框之后、年期列表与通常口径说明一致、窄屏能完整换行。外围上传区沿用现有原型迁移样式，本次未另设计流程。

通常窗口复用 contracts 的 reportingWindow：私募/PPN 两完整年度，其他已支持品种三完整年度，非年末加本年累计中期；不冒充专业合规判断，也不自动认定材料齐备。特殊披露、成立年限不足及调整期间仍由补充说明表达。

最终统一验收待办：用户用自己的项目信息核对准备提示；专业适用性确认。上述事项不替代已完成的自动化验证。
