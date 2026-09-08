// scripts/build-shots.mjs が生成する。手で編集しない
export default {
  "capturedAt": "2026-09-08T13:08:40.854Z",
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
          "ms": 2700,
          "billedMs": 1263,
          "timing": null
        },
        "kitesurf": {
          "file": "/shots/ja-wikipedia-org.kitesurf.png",
          "kb": 390,
          "ms": 17286,
          "billedMs": 15331,
          "timing": null
        },
        "mine": {
          "file": "/shots/ja-wikipedia-org.mine.png",
          "kb": 359,
          "ms": 7783,
          "billedMs": null,
          "timing": {
            "js": true,
            "fetchMs": 460,
            "polyfill": true,
            "subresourceMs": 2047,
            "css": {
              "fetched": 3,
              "skipped": 0,
              "bytes": 230947
            },
            "img": {
              "fetched": 24,
              "skipped": 0,
              "tooBig": 0,
              "bytes": 162714,
              "decodedBytes": 1299560
            },
            "renderMs": 0,
            "recoverFetchMs": 2533,
            "passes": 2,
            "recovered": [
              {
                "asked": 15,
                "got": 15,
                "bytes": 120504,
                "tooBig": 0
              }
            ],
            "jsErrors": 1,
            "encodeMs": 0
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
          "kb": 54,
          "ms": 1516,
          "billedMs": 1166,
          "timing": null
        },
        "kitesurf": {
          "file": "/shots/developer-mozilla-org.kitesurf.png",
          "kb": 66,
          "ms": 7195,
          "billedMs": 6219,
          "timing": null
        },
        "mine": {
          "file": "/shots/developer-mozilla-org.mine.png",
          "kb": 57,
          "ms": 2539,
          "billedMs": null,
          "timing": {
            "js": true,
            "fetchMs": 428,
            "polyfill": true,
            "subresourceMs": 50,
            "css": {
              "fetched": 18,
              "skipped": 0,
              "bytes": 84345
            },
            "img": {
              "fetched": 0,
              "skipped": 0,
              "bytes": 0
            },
            "renderMs": 0,
            "recoverFetchMs": 108,
            "passes": 2,
            "recovered": [
              {
                "asked": 32,
                "got": 32,
                "bytes": 966614,
                "tooBig": 0
              }
            ],
            "jsErrors": 0,
            "encodeMs": 0
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
          "ms": 1330,
          "billedMs": 908,
          "timing": null
        },
        "kitesurf": {
          "file": "/shots/react-dev.kitesurf.png",
          "kb": 84,
          "ms": 5171,
          "billedMs": 4716,
          "timing": null
        },
        "mine": {
          "file": "/shots/react-dev.mine.png",
          "kb": 88,
          "ms": 11753,
          "billedMs": null,
          "timing": {
            "js": true,
            "fetchMs": 58,
            "polyfill": true,
            "subresourceMs": 286,
            "css": {
              "fetched": 1,
              "skipped": 0,
              "bytes": 108608
            },
            "img": {
              "fetched": 24,
              "skipped": 0,
              "tooBig": 0,
              "bytes": 61671,
              "decodedBytes": 1133824
            },
            "renderMs": 0,
            "recoverFetchMs": 1960,
            "passes": 2,
            "recovered": [
              {
                "asked": 66,
                "got": 66,
                "bytes": 3128316,
                "tooBig": 0
              }
            ],
            "jsErrors": 0,
            "encodeMs": 0
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
          "ms": 1397,
          "billedMs": 1115,
          "timing": null
        },
        "kitesurf": {
          "file": "/shots/todomvc-com.kitesurf.png",
          "kb": 91,
          "ms": 2681,
          "billedMs": 2328,
          "timing": null
        },
        "mine": {
          "file": "/shots/todomvc-com.mine.png",
          "kb": 20,
          "ms": 4458,
          "billedMs": null,
          "timing": {
            "js": true,
            "fetchMs": 251,
            "polyfill": true,
            "subresourceMs": 219,
            "css": {
              "fetched": 1,
              "skipped": 0,
              "bytes": 7400
            },
            "img": {
              "fetched": 0,
              "skipped": 0,
              "bytes": 0
            },
            "renderMs": 0,
            "recoverFetchMs": 158,
            "passes": 2,
            "recovered": [
              {
                "asked": 2,
                "got": 2,
                "bytes": 240666,
                "tooBig": 0
              }
            ],
            "jsErrors": 1,
            "encodeMs": 0
          }
        }
      }
    }
  ]
};
