#pragma once

// Copy this file to "secrets.h" in the same folder and fill it in.
// secrets.h is git-ignored. Never commit a real token.
//
// Must equal the backend's DEVICE_TOKEN secret. To read it (Cloud Shell, do not paste it in chat):
//   gcloud secrets versions access latest --secret=DEVICE_TOKEN --project=<your-project>
#define DEVICE_TOKEN "replace-with-the-backend-DEVICE_TOKEN"
