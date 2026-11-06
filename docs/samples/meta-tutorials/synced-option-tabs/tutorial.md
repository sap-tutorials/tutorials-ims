---
title: Try Synced Tabs
description: A short tutorial demonstrating synced OPTION tab groups across multiple steps.
time: 10
tags: [ tutorial>beginner, software-product>sap-cap ]
primary_tag: software-product>sap-cap
syncTabs: auto
---

## Prerequisites
- Basic familiarity with CAP

---

### Step 1: Initialize the project

Pick your runtime and initialize a new CAP project.

[OPTION BEGIN [Node.js] sync=runtime]
Run `npm init -y && npm add @sap/cds-dk` to initialize a Node.js CAP project.

Then scaffold the project structure:

```bash
cds init my-cap-app
cd my-cap-app
npm install
```
[OPTION END]
[OPTION BEGIN [Java] sync=runtime]
Run `mvn archetype:generate` to initialize a Java CAP project:

```bash
mvn archetype:generate \
  -DarchetypeGroupId=com.sap.cds \
  -DarchetypeArtifactId=com.sap.cds.archetype \
  -DarchetypeVersion=RELEASE
```

Follow the prompts to set your project name and package.
[OPTION END]

### Step 2: Add a service

Define a simple CDS service, then add the runtime-specific handler.

[OPTION BEGIN [Node.js]]
Create `srv/hello-service.cds`:

```cds
service HelloService {
  function greet(name : String) returns String;
}
```

Then create `srv/hello-service.js`:

```js
module.exports = (srv) => {
  srv.on('greet', ({ data: { name } }) => `Hello, ${name}!`)
}
```
[OPTION END]
[OPTION BEGIN [Java]]
Create `Application.java` in your main source folder:

```java
@Component
public class HelloServiceHandler implements EventHandler {

  @On(event = "greet", service = "HelloService")
  public void onGreet(CdsCreateEventContext ctx) {
    String name = ctx.getData().get("name").toString();
    ctx.setResult("Hello, " + name + "!");
  }
}
```
[OPTION END]

### Step 3: Run and test

Start the server and try the endpoint.

[OPTION BEGIN [Node.js]]
Run the development server:

```bash
cds watch
```

Open a browser or use `curl` to test:

```bash
curl "http://localhost:4004/hello/greet(name='World')"
```
[OPTION END]
[OPTION BEGIN [Java]]
Run the Spring Boot server:

```bash
mvn spring-boot:run
```

Open a browser or use `curl` to test:

```bash
curl "http://localhost:8080/hello/greet(name='World')"
```
[OPTION END]

### Next Steps

You have now tried synced option tabs. The picker bar at the top of the page
remembers your runtime choice and applies it to every group automatically.

- Read the [CAP documentation](https://cap.cloud.sap/docs/) for more
- Explore more tutorials in the [CAP learning path](/learning-journeys/sap-cap)
