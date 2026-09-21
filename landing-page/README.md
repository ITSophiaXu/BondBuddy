# BondBuddy Landing Page

“BondBuddy — 债券项目的 AI 工作搭档”的完整静态网站源码。首个归档版本为 1.0.0，来自 2026-09-21 本地产品的 `public/website/`；保留页面布局、文案、品牌、交互和六张 SVG 资源。

## 查看页面

直接用浏览器打开 `public/index.html`；或安装 Node.js 22+，在本目录执行：

```sh
npm start
```

访问 `http://127.0.0.1:4321/`。没有第三方 npm 依赖，无需 `npm install`。页面自身不依赖后端；“体验网页版”等按钮默认打开 `http://127.0.0.1:4320/` 上的新产品原型，因此点击这些按钮时需启动 `../product-prototype/`。

## 源码与维护

| 文件 | 用途 |
| --- | --- |
| `public/index.html` | 页面结构、文案、FAQ、套餐与 `site-config` |
| `public/website.css` | 品牌样式、布局和响应式适配 |
| `public/website.js` | 导航、功能切换、图片放大、下载说明弹窗与链接 |
| `public/assets/brand.svg` | 可直接编辑的品牌标记 |
| `public/assets/*.svg` | 五张产品界面示意图，使用明确标识的演示内容 |
| `scripts/build-site-previews.mjs` | 产品示意图的可编辑源布局与生成脚本 |
| `scripts/export-website.mjs` | 将页面、样式、交互和图片合成独立 HTML |
| `exports/bondbuddy-landing.html` | 可直接打开和分享的单文件版本 |

修改插图源布局后运行 `npm run build:previews`；修改官网后运行 `npm run check` 和 `npm run export`，把源文件及更新后的导出文件一起提交。布局与交互设计说明见 [DESIGN.md](DESIGN.md)。

## 迭代和发布

在本目录持续迭代，修改 `package.json` 中的版本并记录到 `CHANGELOG.md`。Git 提交保留每版差异，无需再建 `v2`、`v3` 等重复目录。

`public/` 可以整体交给静态托管服务。发布前在 `public/index.html` 底部 `site-config` 的 `appUrl` 中填写实际产品地址，并同步替换 HTML 中的按钮备用链接。Windows 安装包就绪后再填写 `windowsDownloadUrl` 并更新页面发布状态；当前按钮展示“即将上线”说明。

页面中的产品示意图使用演示内容；正式短信、支付及外部数据能力以实际服务为准。本次仅归档与本地验证，没有部署到公网。
