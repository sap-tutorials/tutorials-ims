<!-- NOT PUBLISHED — batch-publish after PR merge -->
---
title: "Configure an SAP BTP Destination"
type: tutorials
description: "Create and test an HTTP destination in SAP BTP to connect your CAP application to an external API."
slug: "btp-configure-destination-sample"
private: true
stepCount: 3
time: 15
experienceLevel: "Beginner"
primaryTag: "SAP BTP"
author: "SAP Tutorial Team"
notice: "Sample for the ui-instruction-directives feature (openspec: tutorial-ui-instruction-directives). NOT PUBLISHED."
youWillLearn:
  - "How to create an HTTP destination in the BTP cockpit"
  - "How to test the destination with the connection test tool"
  - "How to bind the destination service to your CAP application"
---

## Prerequisites

- An SAP BTP subaccount
- Editor access to the BTP cockpit

---

### 1. Open the Destinations panel

1. Log in to the [SAP BTP Cockpit](https://cockpit.btp.cloud.sap) and navigate to your subaccount.

2. In the left navigation, choose :menu[Connectivity > Destinations].

3. Click :ui[New Destination]{type=button} in the toolbar.

:ask[What types of destinations are supported in SAP BTP Connectivity?]

### 2. Enter the destination details

1. Fill in the **Name** field. Destination names must be unique within a subaccount and may only contain letters, digits, hyphens, and underscores.

2. Set the **Type** to :ui[HTTP]{type=field}.

3. Enter the URL of your target API in the :ui[URL]{type=field} field.

4. Under **Authentication**, select :ui[BasicAuthentication]{type=field} and provide the credentials.

5. Click :ui[Save]{type=button} to store the destination.

:ask[How do I configure OAuth2 client credentials authentication for a BTP destination?]

### 3. Test the connection

1. In the destination list, find your new destination and click the :icon[play]{label="Test Connection"} button to the right of the row.

2. A panel appears with the connection test result. If the test succeeds, the status reads **200 OK**. If it fails, check that the URL is reachable from the BTP connectivity proxy — some on-premise targets require the Cloud Connector.

3. To bind this destination to your CAP application locally, press :kbd[Mod+\`] in Business Application Studio to open a terminal and run:

   ```bash
   cds bind --to your-destination-name
   ```

4. Save the binding file with :kbd[Mod+S].

Congratulations — your destination is configured and ready to use from your CAP application via the `@sap/cds` Connectivity API.
