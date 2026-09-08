// scripts/build-shots.mjs が生成する。手で編集しない
export default {
  "capturedAt": "2026-09-08T13:39:50.757Z",
  "shots": [
    {
      "slug": "ja-wikipedia-org",
      "url": "https://ja.wikipedia.org/wiki/メインページ",
      "w": 1000,
      "h": 780,
      "title": "ja.wikipedia.org",
      "note": "日本語の見出しと本文、2 カラム、写真 24 枚。CSS は 3 枚で 231 KB",
      "engines": {
        "chromium": {
          "file": "/shots/ja-wikipedia-org.chromium.png",
          "kb": 202,
          "ms": 2437,
          "billedMs": 1454,
          "timing": null
        },
        "kitesurf": {
          "file": "/shots/ja-wikipedia-org.kitesurf.png",
          "kb": 390,
          "ms": 9021,
          "billedMs": 8090,
          "timing": null
        },
        "mine": {
          "file": "/shots/ja-wikipedia-org.mine.png",
          "kb": 366,
          "ms": 5434,
          "billedMs": null,
          "timing": {
            "fetchMs": 634,
            "fontMs": 31,
            "pageScriptMs": 4245,
            "encodeMs": 0,
            "passes": 3,
            "resources": 42,
            "jsErrors": 1
          }
        }
      }
    },
    {
      "slug": "developer-mozilla-org",
      "url": "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map",
      "w": 1000,
      "h": 780,
      "title": "developer.mozilla.org",
      "note": "CSS 20 枚。本文中の <code>map()</code> が等幅で出ている。JS は 938 KB 実行してエラー 0 件",
      "engines": {
        "chromium": {
          "file": "/shots/developer-mozilla-org.chromium.png",
          "kb": 60,
          "ms": 1069,
          "billedMs": 790,
          "timing": null
        },
        "kitesurf": {
          "file": "/shots/developer-mozilla-org.kitesurf.png",
          "kb": 68,
          "ms": 9840,
          "billedMs": 8882,
          "timing": null
        },
        "mine": {
          "file": "/shots/developer-mozilla-org.mine.png",
          "kb": 57,
          "ms": 4144,
          "billedMs": null,
          "timing": {
            "fetchMs": 518,
            "fontMs": 67,
            "pageScriptMs": 3448,
            "encodeMs": 0,
            "passes": 3,
            "resources": 50,
            "jsErrors": 0
          }
        }
      }
    },
    {
      "slug": "react-dev",
      "url": "https://react.dev/",
      "w": 1000,
      "h": 780,
      "title": "react.dev",
      "note": "SSG。ページの JS を実行して、React のハイドレーションが通った状態",
      "engines": {
        "chromium": {
          "file": "/shots/react-dev.chromium.png",
          "kb": 153,
          "ms": 1707,
          "billedMs": 1166,
          "timing": null
        },
        "kitesurf": {
          "file": "/shots/react-dev.kitesurf.png",
          "kb": 84,
          "ms": 3985,
          "billedMs": 3575,
          "timing": null
        },
        "mine": {
          "file": "/shots/react-dev.mine.png",
          "kb": 74,
          "ms": 8780,
          "billedMs": null,
          "timing": {
            "fetchMs": 47,
            "fontMs": 37,
            "pageScriptMs": 8311,
            "encodeMs": 0,
            "passes": 3,
            "resources": 91,
            "jsErrors": 0
          }
        }
      }
    },
    {
      "slug": "todomvc-com",
      "url": "https://todomvc.com/examples/react/dist/",
      "w": 1000,
      "h": 780,
      "title": "todomvc.com (React の SPA)",
      "note": "HTML の中は空。見えているものは全部、ページの JS が描いたもの",
      "engines": {
        "chromium": {
          "file": "/shots/todomvc-com.chromium.png",
          "kb": 22,
          "ms": 1627,
          "billedMs": 1091,
          "timing": null
        },
        "kitesurf": {
          "file": "/shots/todomvc-com.kitesurf.png",
          "kb": 91,
          "ms": 2704,
          "billedMs": 2348,
          "timing": null
        },
        "mine": {
          "file": "/shots/todomvc-com.mine.png",
          "kb": 20,
          "ms": 2830,
          "billedMs": null,
          "timing": {
            "fetchMs": 346,
            "fontMs": 32,
            "pageScriptMs": 2111,
            "encodeMs": 0,
            "passes": 2,
            "resources": 3,
            "jsErrors": 1
          }
        }
      }
    }
  ]
};
