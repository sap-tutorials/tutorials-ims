---
title: "U8 codetabs demo"
description: "Demo page for the {{< codetabs >}} shortcode (U8 prototype)."
draft: false
---

# Code-block language tabs (U8)

Pick **Node.js** or **Java** in one block, every other block on the page (and on
every page you visit afterwards) remembers the choice. Persisted in
`localStorage["codetabs-preference"]`.

## Defining a CAP service

{{< codetabs >}}
{{< codetab name="Node.js" lang="js" >}}
const cds = require('@sap/cds')
module.exports = cds.service.impl(function () {
  this.on('READ', 'Books', (req) => {
    return cds.tx(req).run(SELECT.from(this.entities.Books))
  })
})
{{< /codetab >}}
{{< codetab name="Java" lang="java" >}}
@Component
@ServiceName("CatalogService")
public class CatalogServiceHandler implements EventHandler {

  @On(event = CdsService.EVENT_READ, entity = "CatalogService.Books")
  public void onReadBooks(CdsReadEventContext context) {
    context.setResult(context.getCqn().select().execute());
  }
}
{{< /codetab >}}
{{< /codetabs >}}

## Querying with cds.ql vs raw HANA SQL

{{< codetabs >}}
{{< codetab name="Node.js" lang="js" >}}
const books = await SELECT.from(Books).where({ stock: { '>': 0 } })
{{< /codetab >}}
{{< codetab name="Java" lang="java" >}}
List<Books> books = db.run(Select.from(BOOKS).where(b -> b.stock().gt(0))).listOf(Books.class);
{{< /codetab >}}
{{< /codetabs >}}

## A block with a unique third tab — Node.js / Java / TypeScript

When you've already picked **Java** above, this block keeps Java selected. Pick
**TypeScript** here and every other block falls back to its first tab (because
they don't have a TypeScript option).

{{< codetabs >}}
{{< codetab name="Node.js" lang="js" >}}
const cds = require('@sap/cds')
{{< /codetab >}}
{{< codetab name="Java" lang="java" >}}
import com.sap.cds.services.cds.CdsService;
{{< /codetab >}}
{{< codetab name="TypeScript" lang="ts" >}}
import cds from '@sap/cds'
{{< /codetab >}}
{{< /codetabs >}}
