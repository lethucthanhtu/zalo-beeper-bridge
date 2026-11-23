import { defineConfig, type DefaultTheme } from 'vitepress';

const repo = 'https://github.com/lethucthanhtu/zalo-beeper-bridge';

// GitHub Pages serves the site under /<repo>/; a custom domain or local preview uses '/'.
const base = (process.env.DOCS_BASE ?? '/') as `/${string}/` | '/';

// ---------------------------------------------------------------------------
// Navigation, defined once. Each label is `[English, Vietnamese]`; `link` is the
// English path, and a locale prefix is added when the nav is built.
// `shared` links (the changelog) are never translated and stay at the root.
// ---------------------------------------------------------------------------
type Label = readonly [en: string, vi: string];
type Entry = { text: Label; link: string; shared?: boolean };

const topNav: (Entry & { activeMatch?: string })[] = [
  { text: ['Guide', 'Hướng dẫn'], link: '/guide/what-is-it', activeMatch: '/guide/' },
  { text: ['Deployment', 'Triển khai'], link: '/deployment/container', activeMatch: '/deployment/' },
  {
    text: ['History import', 'Nhập lịch sử'],
    link: '/history-import/',
    activeMatch: '/history-import/',
  },
  { text: ['Reference', 'Tham khảo'], link: '/reference/architecture', activeMatch: '/reference/' },
  { text: ['Changelog', 'Changelog (EN)'], link: '/changelog', shared: true },
];

const sidebarSections: { text: Label; items: Entry[] }[] = [
  {
    text: ['Introduction', 'Giới thiệu'],
    items: [
      { text: ['What is it?', 'Đây là gì?'], link: '/guide/what-is-it' },
      { text: ['Getting started', 'Bắt đầu'], link: '/guide/getting-started' },
      { text: ['Features', 'Tính năng'], link: '/guide/features' },
    ],
  },
  {
    text: ['Using the bridge', 'Sử dụng bridge'],
    items: [
      { text: ['Configuration', 'Cấu hình'], link: '/guide/configuration' },
      { text: ['Bot commands', 'Lệnh của bot'], link: '/guide/bot-commands' },
      { text: ['How it works', 'Cách hoạt động'], link: '/guide/how-it-works' },
      { text: ['Multiple accounts', 'Nhiều tài khoản'], link: '/guide/multiple-accounts' },
    ],
  },
  {
    text: ['Deployment', 'Triển khai'],
    items: [
      { text: ['Container (Docker / Podman)', 'Container (Docker / Podman)'], link: '/deployment/container' },
      { text: ['macOS (launchd)', 'macOS (launchd)'], link: '/deployment/macos-launchd' },
      { text: ['Operations', 'Vận hành'], link: '/deployment/operations' },
    ],
  },
  {
    text: ['History import', 'Nhập lịch sử'],
    items: [
      { text: ['Overview', 'Tổng quan'], link: '/history-import/' },
      { text: ['Quick start', 'Bắt đầu nhanh'], link: '/history-import/quick-start' },
      { text: ['Manual steps', 'Các bước thủ công'], link: '/history-import/manual' },
      { text: ['Importer CLI', 'CLI của công cụ nhập'], link: '/history-import/importer-cli' },
    ],
  },
  {
    text: ['Help', 'Trợ giúp'],
    items: [
      { text: ['Troubleshooting', 'Xử lý sự cố'], link: '/troubleshooting' },
      { text: ['FAQ', 'Câu hỏi thường gặp'], link: '/faq' },
      { text: ['Security & privacy', 'Bảo mật và riêng tư'], link: '/security' },
    ],
  },
  {
    text: ['Reference', 'Tham khảo'],
    items: [
      { text: ['Architecture', 'Kiến trúc'], link: '/reference/architecture' },
      { text: ['Database schema', 'Schema cơ sở dữ liệu'], link: '/reference/database' },
      { text: ['Logs', 'Log'], link: '/reference/logs' },
    ],
  },
  {
    text: ['Project', 'Dự án'],
    items: [
      { text: ['Development', 'Phát triển'], link: '/contributing/development' },
      { text: ['Translations', 'Dịch tài liệu'], link: '/contributing/translations' },
      { text: ['Changelog', 'Changelog (EN)'], link: '/changelog', shared: true },
    ],
  },
];

/** Builds the nav and sidebar for one locale. `i` picks the label (0 = en, 1 = vi). */
function navigation(i: 0 | 1, prefix: '' | '/vi') {
  const to = (e: Entry) => (e.shared ? e.link : `${prefix}${e.link}`);
  const nav: DefaultTheme.NavItem[] = topNav.map((e) => ({
    text: e.text[i],
    link: to(e),
    ...(e.activeMatch ? { activeMatch: `${prefix}${e.activeMatch}` } : {}),
  }));
  const sidebar: DefaultTheme.SidebarItem[] = sidebarSections.map((s) => ({
    text: s.text[i],
    items: s.items.map((e) => ({ text: e.text[i], link: to(e) })),
  }));
  return { nav, sidebar };
}

const en = navigation(0, '');
const vi = navigation(1, '/vi');

export default defineConfig({
  title: 'zalo-beeper-bridge',
  description: 'Self-hosted Matrix bridge that brings a personal Zalo account into Beeper.',
  base,
  cleanUrls: true,
  lastUpdated: true,
  // Internal planning notes live next to the docs but are never published.
  srcExclude: ['*-plan.md'],
  head: [['meta', { name: 'theme-color', content: '#0068ff' }]],

  // English is the default and lives at the site root; Vietnamese lives under /vi/.
  // Every English page under docs/ has a counterpart under docs/vi/ (the changelog is
  // the one exception). See docs/contributing/translations.md.
  locales: {
    root: {
      label: 'English',
      lang: 'en-US',
      themeConfig: {
        nav: en.nav,
        sidebar: en.sidebar,
        editLink: { pattern: `${repo}/edit/main/docs/:path`, text: 'Edit this page on GitHub' },
        footer: {
          message: 'MIT licensed. Not affiliated with Zalo/VNG or Beeper.',
          copyright: 'Copyright © Le Thuc Thanh Tu and contributors',
        },
      },
    },
    vi: {
      label: 'Tiếng Việt',
      lang: 'vi-VN',
      link: '/vi/',
      description: 'Matrix bridge tự host, đưa tài khoản Zalo cá nhân vào Beeper.',
      themeConfig: {
        nav: vi.nav,
        sidebar: vi.sidebar,
        editLink: {
          pattern: `${repo}/edit/main/docs/:path`,
          text: 'Sửa trang này trên GitHub',
        },
        footer: {
          message: 'Giấy phép MIT. Không liên kết với Zalo/VNG hay Beeper.',
          copyright: 'Copyright © Le Thuc Thanh Tu và những người đóng góp',
        },
        outline: { level: [2, 3], label: 'Trong trang này' },
        docFooter: { prev: 'Trang trước', next: 'Trang sau' },
        lastUpdated: { text: 'Cập nhật lần cuối' },
        darkModeSwitchLabel: 'Giao diện',
        lightModeSwitchTitle: 'Chuyển sang giao diện sáng',
        darkModeSwitchTitle: 'Chuyển sang giao diện tối',
        sidebarMenuLabel: 'Menu',
        returnToTopLabel: 'Lên đầu trang',
        langMenuLabel: 'Đổi ngôn ngữ',
        skipToContentLabel: 'Chuyển đến nội dung',
      },
    },
  },

  themeConfig: {
    socialLinks: [{ icon: 'github', link: repo }],
    search: {
      provider: 'local',
      options: {
        locales: {
          vi: {
            translations: {
              button: { buttonText: 'Tìm kiếm', buttonAriaLabel: 'Tìm kiếm' },
              modal: {
                displayDetails: 'Hiện chi tiết',
                resetButtonTitle: 'Xoá tìm kiếm',
                backButtonTitle: 'Đóng tìm kiếm',
                noResultsText: 'Không có kết quả cho',
                footer: {
                  selectText: 'chọn',
                  selectKeyAriaLabel: 'enter',
                  navigateText: 'di chuyển',
                  navigateUpKeyAriaLabel: 'mũi tên lên',
                  navigateDownKeyAriaLabel: 'mũi tên xuống',
                  closeText: 'đóng',
                  closeKeyAriaLabel: 'esc',
                },
              },
            },
          },
        },
      },
    },
    outline: { level: [2, 3] },
  },
});
