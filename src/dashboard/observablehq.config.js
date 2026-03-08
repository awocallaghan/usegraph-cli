import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Resolve the output directory relative to this config file so that
// `observable build` always writes to src/dashboard/dist/ regardless of
// which working directory the command is invoked from.  Without this, the
// default output of "dist" is resolved against the process CWD, which can
// be the package root — overwriting the compiled CLI JavaScript files.
const __dirname = dirname(fileURLToPath(import.meta.url));

export default {
  title: "usegraph",
  root: "pages",
  output: join(__dirname, "dist"),
  base: process.env.BASE_PATH,
  pages: [
    { name: "Overview", path: "/" },
    { name: "Dependencies", path: "/dependencies" },
    { name: "Package Adoption", path: "/package-adoption" },
    { name: "Project Detail", path: "/project-detail" },
    { name: "Component Explorer", path: "/component-explorer" },
    { name: "Function Explorer", path: "/function-explorer" },
    { name: "CI Overview", path: "/ci-overview" },
    { name: "CI Template Explorer", path: "/ci-template-explorer" },
  ],
};
