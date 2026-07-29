(() => {
  const VDITOR_VERSION = "3.11.1";
  const VDITOR_BASE = `/assets/vditor/${VDITOR_VERSION}`;
  const contentElement = document.getElementById("markdown-content");
  const loadingElement = document.getElementById("markdown-loading");
  const errorElement = document.getElementById("markdown-error");
  const sourceLink = document.getElementById("markdown-source-link");

  const setError = (error) => {
    if (loadingElement) loadingElement.hidden = true;
    if (errorElement) {
      errorElement.hidden = false;
      errorElement.textContent = error?.message || "Markdown 文档加载失败";
    }
  };

  const loadScript = (src) =>
    new Promise((resolve, reject) => {
      if (window.Vditor) {
        resolve();
        return;
      }
      const script = document.createElement("script");
      script.src = src;
      script.onload = resolve;
      script.onerror = () => reject(new Error("Markdown 渲染器加载失败"));
      document.head.appendChild(script);
    });

  const rawUrl = new URL(window.location.href);
  rawUrl.searchParams.set("__cloudpaste_raw", "1");
  if (sourceLink) sourceLink.href = rawUrl.toString();

  Promise.all([
    fetch(rawUrl, {
      headers: { Accept: "text/markdown, text/plain;q=0.9" },
      credentials: "same-origin",
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Markdown 文档读取失败（HTTP ${response.status}）`);
      return response.text();
    }),
    loadScript(`${VDITOR_BASE}/dist/index.min.js`),
  ])
    .then(([markdown]) => {
      if (!window.Vditor || typeof window.Vditor.preview !== "function") {
        throw new Error("Markdown 渲染器不可用");
      }

      const darkMode = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches === true;
      window.Vditor.preview(contentElement, markdown, {
        mode: "dark-light",
        cdn: VDITOR_BASE,
        theme: {
          current: darkMode ? "dark" : "light",
          path: `${VDITOR_BASE}/dist/css/content-theme`,
        },
        hljs: {
          lineNumber: true,
          style: darkMode ? "vs2015" : "github",
        },
        markdown: {
          sanitize: true,
          toc: true,
          mark: true,
          footnotes: true,
          autoSpace: true,
          media: true,
          listStyle: true,
          task: true,
        },
        math: {
          engine: "KaTeX",
          inlineDigit: true,
        },
        after: () => {
          if (loadingElement) loadingElement.hidden = true;
          contentElement.hidden = false;
          contentElement.querySelectorAll("a[href]").forEach((link) => {
            try {
              const target = new URL(link.href, window.location.href);
              if (target.origin !== window.location.origin) {
                link.target = "_blank";
                link.rel = "noopener noreferrer";
              }
            } catch {
              // 保留无法解析的原始链接。
            }
          });
        },
      });
    })
    .catch(setError);
})();
