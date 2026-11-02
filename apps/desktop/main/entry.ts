import { bootstrapDesktop } from "./bootstrap";

// Kept external by esbuild: loading the business bundle happens after the first frame.
void bootstrapDesktop(() => require("./main.cjs"));
