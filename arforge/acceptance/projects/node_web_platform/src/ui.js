const React = require("react");
const {renderToStaticMarkup: renderReact} = require("react-dom/server");
const {createSSRApp, h} = require("vue");
const {renderToString: renderVue} = require("vue/server-renderer");

function renderReactStatus(status) {
  return renderReact(React.createElement("strong", null, `React:${status}`));
}

async function renderVueStatus(status) {
  return renderVue(createSSRApp({render: () => h("strong", `Vue:${status}`)}));
}

module.exports = {renderReactStatus, renderVueStatus};
