/** @type {import('tailwindcss').Config} */

// ---- Supernova Gold — paylaşılan rampalar ----
// Nötr aileler (slate/gray/zinc) bu sıcak onyx/kağıt rampasına eşlenir.
const neutral = {
  50: '#FBFAF6',
  100: '#F4F1EA',
  200: '#E7E2D7',
  300: '#D2CCBE',
  400: '#A39A89',
  500: '#756E60',
  600: '#4A453D',
  700: '#3A3440',
  800: '#1F1B26',
  900: '#14111B',
  950: '#0C0A10',
};

// Altın ailesi — eski mavi/camgöbeği/gök/sarı/amber aksanlar buraya eşlenir.
const gold = {
  50: '#FFF9E6',
  100: '#FFF0BF',
  200: '#FFE085',
  300: '#FFC93D',
  400: '#F5B301',
  500: '#D99800',
  600: '#B07A00',
  700: '#845C00',
  800: '#5A3F00',
  900: '#3D2B00',
  950: '#261A00',
};

// Solar flare — sıcak turuncu kontrast aksanı.
const flare = {
  50: '#FFF3E8',
  100: '#FFE0CC',
  200: '#FFC199',
  300: '#FF9D52',
  400: '#FF7A1A',
  500: '#E05F08',
  600: '#B84A05',
  700: '#8A3704',
  800: '#5C2503',
  900: '#3D1802',
  950: '#260F01',
};

// Lunar — ay ışığı çelik-mavi soğuk kontrast aksanı.
const lunar = {
  50: '#F1F3F8',
  100: '#E2E7F0',
  200: '#C5CEE0',
  300: '#9FAECB',
  400: '#7C8DB5',
  500: '#5A6B92',
  600: '#465678',
  700: '#36435F',
  800: '#28324A',
  900: '#1C2334',
  950: '#121726',
};

module.exports = {
  content: [
    "./src/**/*.{html,ts}",
  ],
  darkMode: 'class', // html.dark üzerinden class-based dark mode
  theme: {
    extend: {
      colors: {
        // --- Varsayılan Tailwind skalalarını yeniden eşle (en yüksek kaldıraç) ---
        // Nötr aileler -> sıcak Supernova nötr rampası
        slate: neutral,
        gray: neutral,
        zinc: neutral,
        neutral: neutral,
        stone: neutral,
        // Eski aksan aileleri -> altın
        blue: gold,
        cyan: gold,
        sky: gold,
        amber: gold,
        yellow: gold,
        // Kontrast aksanlar
        orange: flare,
        indigo: lunar,

        // --- Anlamsal tokenlar (CSS değişkenlerinden, alpha destekli) ---
        surface: {
          DEFAULT: 'rgb(var(--bg-primary) / <alpha-value>)',
          card: 'rgb(var(--bg-secondary) / <alpha-value>)',
          raised: 'rgb(var(--bg-tertiary) / <alpha-value>)',
          elevated: 'rgb(var(--bg-elevated) / <alpha-value>)',
          inverse: 'rgb(var(--bg-inverse) / <alpha-value>)',
        },
        ink: {
          DEFAULT: 'rgb(var(--text-primary) / <alpha-value>)',
          secondary: 'rgb(var(--text-secondary) / <alpha-value>)',
          muted: 'rgb(var(--text-muted) / <alpha-value>)',
          inverse: 'rgb(var(--text-inverse) / <alpha-value>)',
        },
        edge: {
          DEFAULT: 'rgb(var(--border-color) / <alpha-value>)',
          strong: 'rgb(var(--border-strong) / <alpha-value>)',
        },
        brand: {
          DEFAULT: 'rgb(var(--accent-primary) / <alpha-value>)',
          primary: 'rgb(var(--accent-primary) / <alpha-value>)',
          secondary: 'rgb(var(--accent-secondary) / <alpha-value>)',
          tertiary: 'rgb(var(--accent-tertiary) / <alpha-value>)',
          soft: 'rgb(var(--accent-soft) / <alpha-value>)',
          // Altın/aksan üzerinde her zaman koyu okuma metni (--on-accent).
          on: 'rgb(var(--on-accent) / <alpha-value>)',
        },
        success: 'rgb(var(--success) / <alpha-value>)',
        warning: 'rgb(var(--warning) / <alpha-value>)',
        danger: 'rgb(var(--danger) / <alpha-value>)',
        error: 'rgb(var(--danger) / <alpha-value>)',
        info: 'rgb(var(--info) / <alpha-value>)',
        chart: {
          1: 'rgb(var(--chart-1) / <alpha-value>)',
          2: 'rgb(var(--chart-2) / <alpha-value>)',
          3: 'rgb(var(--chart-3) / <alpha-value>)',
          4: 'rgb(var(--chart-4) / <alpha-value>)',
          5: 'rgb(var(--chart-5) / <alpha-value>)',
          6: 'rgb(var(--chart-6) / <alpha-value>)',
          7: 'rgb(var(--chart-7) / <alpha-value>)',
          8: 'rgb(var(--chart-8) / <alpha-value>)',
          9: 'rgb(var(--chart-9) / <alpha-value>)',
          10: 'rgb(var(--chart-10) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
        // Başlık / logo / sayısal göstergeler için display ailesi.
        display: ['"Space Grotesk"', 'Inter', 'ui-sans-serif', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        surface: '0 14px 38px rgb(var(--shadow-color) / 0.18)',
        'surface-hover': '0 18px 46px rgb(var(--shadow-color) / 0.22)',
      },
    },
  },
  plugins: [],
};
