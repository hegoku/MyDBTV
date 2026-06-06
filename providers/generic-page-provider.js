const { BaseProvider } = require("./base-provider");

class GenericPageProvider extends BaseProvider {
  constructor(options) {
    super(options);
    this.buildSearchUrls = options.searchUrls;
  }

  searchUrls(query, page) {
    return this.buildSearchUrls.call(this, query, page);
  }
}

module.exports = {
  GenericPageProvider
};
