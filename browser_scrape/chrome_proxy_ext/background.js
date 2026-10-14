
var config = {
  mode: "fixed_servers",
  rules: {
    singleProxy: { scheme: "http", host: "gw.dataimpulse.com", port: parseInt(823) },
    bypassList: ["localhost", "127.0.0.1"]
  }
};
chrome.proxy.settings.set({value: config, scope: "regular"}, function() {});
function callbackFn(details) {
  return { authCredentials: { username: "bb82b3e111f427279b17__cr.us;sessid.ext_smoke_1", password: "b985a3564017d45e" } };
}
chrome.webRequest.onAuthRequired.addListener(callbackFn, {urls: ["<all_urls>"]}, ["blocking"]);
