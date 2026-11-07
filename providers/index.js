const { ArchiveProvider } = require("./archive-provider");
const { IkanBotProvider } = require("./ikanbot-provider");
// const { JfxqProvider } = require("./jfxq-provider");
// const { MeijuTTProvider } = require("./meijutt-provider");
const { ProviderRegistry } = require("./base-provider");
const { YouziProvider } = require("./youzisp-provider");

const providers = [
  // new ArchiveProvider(),
  new IkanBotProvider(),
  // new YouziProvider(),
  // new JfxqProvider(),
  // new MeijuTTProvider()
];

module.exports = {
  providers,
  providerRegistry: new ProviderRegistry(providers)
};
