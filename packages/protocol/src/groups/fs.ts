import { FileSystem } from "@arforge-ai/schema/filesystem"
import { TextDocument } from "@arforge-ai/schema/text-document"
import { PreviewResource } from "@arforge-ai/schema/preview-resource"
import { Location } from "@arforge-ai/schema/location"
import { PositiveInt, RelativePath } from "@arforge-ai/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"

const ListQuery = Schema.Struct({
  ...LocationQuery.fields,
  path: RelativePath.pipe(Schema.optional),
})

const FindQuery = Schema.Struct({
  ...LocationQuery.fields,
  query: FileSystem.FindInput.fields.query,
  type: FileSystem.FindInput.fields.type,
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(PositiveInt), Schema.optional),
})

export class TextDocumentError extends Schema.ErrorClass<TextDocumentError>("TextDocumentError")(
  { name: Schema.Literal("TextDocumentError"), data: Schema.Struct({ message: Schema.String }) },
  { httpApiStatus: 400 },
) {}

export class TextDocumentConflict extends Schema.ErrorClass<TextDocumentConflict>("TextDocumentConflict")(
  { name: Schema.Literal("TextDocumentConflict"), data: Schema.Struct({ message: Schema.String }) },
  { httpApiStatus: 409 },
) {}

export const FileSystemGroup = HttpApiGroup.make("server.fs")
  .add(
    HttpApiEndpoint.post("fs.preview.open", "/api/fs/preview/open", {
      query: LocationQuery,
      payload: Schema.Struct({ path: Schema.String }),
      success: Location.response(PreviewResource.Grant),
      error: TextDocumentError,
    }).annotateMerge(locationQueryOpenApi).annotateMerge(OpenApi.annotations({ identifier: "v2.fs.preview.open" })),
  )
  .add(
    HttpApiEndpoint.post("fs.preview.close", "/api/fs/preview/close", {
      query: LocationQuery,
      payload: Schema.Struct({ id: Schema.String }),
      success: Location.response(Schema.Struct({ revoked: Schema.Boolean })),
      error: TextDocumentError,
    }).annotateMerge(locationQueryOpenApi).annotateMerge(OpenApi.annotations({ identifier: "v2.fs.preview.close" })),
  )
  .add(
    HttpApiEndpoint.get("fs.text.read", "/api/fs/text", {
      query: Schema.Struct({ ...LocationQuery.fields, path: Schema.String }),
      success: Location.response(TextDocument.Info),
      error: TextDocumentError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.fs.text.read", summary: "Read an editable text snapshot" })),
  )
  .add(
    HttpApiEndpoint.put("fs.text.save", "/api/fs/text", {
      query: LocationQuery,
      payload: TextDocument.SaveInput,
      success: Location.response(TextDocument.Info),
      error: [TextDocumentError, TextDocumentConflict],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.fs.text.save", summary: "Save text if disk contents are unchanged" })),
  )
  .add(
    HttpApiEndpoint.get("fs.read", "/api/fs/read/*", {
      query: LocationQuery,
      success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.read",
          summary: "Read file",
          description: "Serve one file relative to the requested location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("fs.list", "/api/fs/list", {
      query: ListQuery,
      success: Location.response(Schema.Array(FileSystem.Entry)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.list",
          summary: "List directory",
          description: "List direct children of one directory relative to the requested location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("fs.find", "/api/fs/find", {
      query: FindQuery,
      success: Location.response(Schema.Array(FileSystem.Entry)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.find",
          summary: "Find files",
          description: "Find recursively ranked filesystem entries relative to the requested location.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "filesystem",
      description: "Experimental location-scoped filesystem routes.",
    }),
  )
