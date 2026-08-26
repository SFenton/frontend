class TestCustomPanel extends HTMLElement {
  connectedCallback() {
    this.textContent = "Custom panel loaded";
  }
}

if (!customElements.get("test-custom-panel")) {
  customElements.define("test-custom-panel", TestCustomPanel);
}
