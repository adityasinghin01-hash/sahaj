const { hairlineWidth } = require('nativewind/theme');

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
        secondary: { DEFAULT: 'hsl(var(--secondary))', foreground: 'hsl(var(--secondary-foreground))' },
        destructive: { DEFAULT: 'hsl(var(--destructive))', foreground: '#FFFFFF' },
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
        popover: { DEFAULT: 'hsl(var(--popover))', foreground: 'hsl(var(--popover-foreground))' },
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
        // Sahaj tokens (hex = measured values)
        cream: '#FDF9F8',
        ink: { DEFAULT: '#140E0C', 2: '#3A302D', muted: '#7D716E', faint: '#A39793' },
        sand: { DEFAULT: '#F5EEED', 2: '#EBE2E0', line: '#E7DDDA' },
        brand: { DEFAULT: '#C5523A', ink: '#A9432E', soft: '#F8E6E0', deep: '#7E2F1F' },
        teal: { DEFAULT: '#1F7A72', ink: '#1A6A63', soft: '#E1F0EE', deep: '#0F4743' },
        ok: { DEFAULT: '#2F7D57', ink: '#276B4A', soft: '#E4F1EA' },
        watch: { DEFAULT: '#A86A12', ink: '#8A560C', soft: '#F7ECD9' },
        danger: { DEFAULT: '#C42B3A', ink: '#B0222F', soft: '#F9E2E4' },
      },
      fontFamily: {
        jk: ['PlusJakartaSans_400Regular'],
        'jk-medium': ['PlusJakartaSans_500Medium'],
        'jk-semibold': ['PlusJakartaSans_600SemiBold'],
        'jk-bold': ['PlusJakartaSans_700Bold'],
        'jk-extrabold': ['PlusJakartaSans_800ExtraBold'],
        hi: ['NotoSansDevanagari_400Regular'],
        'hi-semibold': ['NotoSansDevanagari_600SemiBold'],
      },
      borderRadius: {
        xl: '20px',
        '2xl': '24px',
        '3xl': '32px',
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 4px)',
        sm: 'calc(var(--radius) - 8px)',
      },
      borderWidth: { hairline: hairlineWidth() },
    },
  },
  future: { hoverOnlyWhenSupported: true },
  plugins: [require('tailwindcss-animate')],
};
