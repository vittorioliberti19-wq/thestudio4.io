module.exports = {
  content: ["./index.html", "./galeria.html"],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Montserrat"', "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "monospace"],
      },
      colors: {
        ink: "#000000",
        paper: "#ffffff",
      },
      letterSpacing: {
        tighter2: "-0.04em",
        widest2: "0.22em",
      },
    },
  },
  plugins: [],
};
