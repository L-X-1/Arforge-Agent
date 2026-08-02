import "zone.js";

import {Component} from "@angular/core";
import {bootstrapApplication} from "@angular/platform-browser";

@Component({
  selector: "app-root",
  standalone: true,
  template: `
    <main>
      <h1>Arforge project depth</h1>
      <label>
        Title
        <input id="title" maxlength="200">
      </label>
      <p id="policy">Blank titles are rejected</p>
    </main>
  `,
})
class AppComponent {}

bootstrapApplication(AppComponent).catch((error) => {
  console.error(error);
  document.body.dataset.bootstrap = "failed";
});
