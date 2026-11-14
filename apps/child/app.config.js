// EAS file environment variable: a path to Firebase's Android client configuration.
// Never inline file contents or FCM service-account credentials into the JS config.
module.exports = ({ config }) => {
  const googleServicesFile = process.env.GOOGLE_SERVICES_JSON;
  return {
    ...config,
    android: {
      ...config.android,
      ...(googleServicesFile ? { googleServicesFile } : {}),
    },
  };
};
