# NeoRead 标题手写字体

来自 NeoRead 官网标题：Caveat，字重 600，正常体。

- `Caveat-NeoRead-600.ttf`：与官网 Google Fonts 请求一致的 NeoRead 字符子集，仅用于品牌文字，不适合任意文本。
- `caveat.css`：本地字体声明，导入后使用 `font-family: "NeoRead Caveat", cursive; font-weight: 600;`。
- `OFL.txt`：SIL Open Font License 1.1，分发字体时一同保留。

官网标题样式为 `line-height: 1`，首页字号 `clamp(46px, 5.8vw, 70px)`，文字向下偏移 `2px`。

来源：https://fonts.googleapis.com/css2?family=Caveat:wght@600&text=NeoRead&display=swap
授权来源：https://github.com/google/fonts/blob/main/ofl/caveat/OFL.txt

桌面启动页在构建时把字体内嵌为 data URL（`apps/desktop/main/startup-animation.ts`），并随安装包分发 `LICENSE-Caveat.txt`。
