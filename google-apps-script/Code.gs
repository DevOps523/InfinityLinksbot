function getSubscriptionApiConfig_() {
  const properties = PropertiesService.getScriptProperties();
  const baseUrl = properties.getProperty("SUBSCRIPTION_API_BASE_URL");
  const token = properties.getProperty("SUBSCRIPTION_ADMIN_TOKEN");

  if (!baseUrl || !token) {
    throw new Error(
      "Set SUBSCRIPTION_API_BASE_URL and SUBSCRIPTION_ADMIN_TOKEN in Script Properties.",
    );
  }

  if (!/^https:\/\//i.test(baseUrl)) {
    throw new Error("SUBSCRIPTION_API_BASE_URL must use https.");
  }

  return { baseUrl: baseUrl.replace(/\/$/, ""), token };
}

function callSubscriptionApi_(path) {
  const config = getSubscriptionApiConfig_();
  const response = UrlFetchApp.fetch(config.baseUrl + path, {
    method: "post",
    muteHttpExceptions: true,
    headers: {
      Authorization: "Bearer " + config.token,
    },
  });
  const body = response.getContentText();

  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    throw new Error(
      "Subscription API failed: " + response.getResponseCode() + " " + body,
    );
  }

  return JSON.parse(body);
}

function updateSubscription() {
  const result = callSubscriptionApi_("/api/subscriptions/update");
  SpreadsheetApp.getActive().toast(
    "Subscription sheet updated: " + JSON.stringify(result.subscriptions),
  );
}

function sendAlert() {
  const result = callSubscriptionApi_("/api/subscriptions/send-alert");
  SpreadsheetApp.getActive().toast(
    "Subscription alert updated: " + JSON.stringify(result.alert),
  );
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Subscriptions")
    .addItem("Update Subscription", "updateSubscription")
    .addItem("Send Alert", "sendAlert")
    .addToUi();
}
