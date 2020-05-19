/**
 * Copyright (c) 2019-2020 SUSE LLC
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 * the Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
 * FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
 * COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
 * IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
 * CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

import * as assert from "assert";
import * as http from "http";
import * as https from "https";
import { URL } from "url";
import { ApiError } from "./error";
import { newXmlBuilder, newXmlParser } from "./xml";

/**
 * Converts a url into a well defined format (e.g. whether `/` should be
 * appended).
 *
 * @param url  The url to be normalized. An exception is thrown if this is not a
 *     valid url.
 *
 * @throw `TypeError` when the parameter `url` is not valid.
 */
export function normalizeUrl(url: string): string {
  return new URL(url).toString();
}

/**
 * The supported request methods by [[Connection.makeApiCall]].
 */
export const enum RequestMethod {
  GET = "GET",
  POST = "POST",
  PUT = "PUT",
  DELETE = "DELETE"
}

export interface ApiCallMainOptions {
  /**
   * The method used to perform the request. Defaults to
   * [[GET|RequestMethod.GET]].
   */
  method?: RequestMethod;

  /**
   * An arbitrary object to be sent along with the request.
   *
   * This object is encoded to XML via the builder obtained from
   * [[newXmlBuilder]].
   */
  payload?: any;

  /**
   * Whether `payload` should be sent as it is. If false (or omitted), then
   * `payload` is expected to be an object that is encoded to XML via the
   * builder obtained via [[newXmlBuilder]]
   */
  sendPayloadAsRaw?: boolean;
}

export interface ApiCallOptions extends ApiCallMainOptions {
  /**
   * Whether the response is assumed to be XML and decoded into a JS object
   * using the parser obtained from [[newXmlParser]].
   *
   * The response is by default assumed to be XML.
   */
  decodeResponseFromXml?: boolean;
}

/**
 * Class for storing the credentials to connect to an Open Build Service
 * instance.
 *
 * It stores cookies persistently between requests, so that instances of the
 * Open Build Service that send session cookies can use these and don't have to
 * issue a new session per request.
 */
export class Connection {
  /** the username which will be used to connect to the API */
  public readonly username: string;

  /** URL to the API of this buildservice instance */
  public readonly url: string;

  /** the user's password */
  private readonly password: string;

  /** HTTP simple auth header containing the necessary credentials */
  private readonly headers: string;

  private cookies: string[] = [];

  private readonly serverCaCertificate?: string;

  private readonly request: typeof http.request | typeof https.request;

  /**
   * Construct a connection using the provided username and password
   * @param username  username used for authentication
   * @param password  password of the user
   * @param options  Additional options for the new Connection:
   *     - `url`: URL to the API, it **must** use `https` unless `forceHttps` is
   *       set to false.
   *       `https://api.opensuse.org/` is used if unspecified.
   *       CAUTION: this is **not** the URL to the webpage of the buildservice
   *       instance (usually you have to swap the initial `build.` to `api.`).
   *     - `serverCaCertificate` A custom root certificate in the PEM format
   *       that should be used to connect to the API.
   *       If not provided, nodejs will by default use its certificate chain,
   *       which may or may not include the system certificates. Thus
   *       connections to servers with certificates signed by custom CAs *can*
   *       fail.
   *     - `forceHttps`: If set to `false`, then the constructor will accept
   *        http urls as well. Other protocols are rejected.
   *
   * @throw Error when the url is invalid or when it does not use https (and
   *     `forceHttps` is true or undefined).
   */
  constructor(
    username: string,
    password: string,
    options: {
      url?: string;
      serverCaCertificate?: string;
      forceHttps?: boolean;
    } = {}
  ) {
    this.password = password;
    this.username = username;

    this.headers = `${this.username}:${this.password}`;
    this.serverCaCertificate = options.serverCaCertificate;

    this.url = normalizeUrl(options.url ?? "https://api.opensuse.org");

    const protocol = new URL(this.url).protocol;
    if (options.forceHttps === undefined || options.forceHttps) {
      if (protocol !== "https:") {
        throw new Error(
          `${this.url} does not use https, got ${protocol} instead`
        );
      }
    } else {
      if (protocol !== "https:" && protocol !== "http:") {
        throw new Error(
          `${this.url} doesn't use http or https, got ${protocol} instead`
        );
      }
    }
    this.request = protocol === "https:" ? https.request : http.request;
  }

  /**
   * Create a copy of the current Connection preserving its password with
   * optional new settings.
   *
   * If some of the parameters are not provided, then the current values are
   * used. Note that the cookies are **not** cloned into the new Connection!
   *
   * @param username  An optional new username.
   * @param url  An optional new URL to the API.
   * @param serverCaCertificate  An optional new server certificate.
   * @param forceHttps  Whether to enforce https or permit http as well (defaults
   *     to `true` = enforce https).
   *
   * @return A new Connection that has the same password as the current
   *     Connection object.
   *
   * @throw Same errors as the constructor.
   */
  public clone({
    username,
    url,
    serverCaCertificate,
    forceHttps
  }: {
    username?: string;
    url?: string;
    serverCaCertificate?: string;
    forceHttps?: boolean;
  } = {}): Connection {
    return new Connection(username ?? this.username, this.password, {
      url: url ?? this.url,
      serverCaCertificate: serverCaCertificate ?? this.serverCaCertificate,
      forceHttps
    });
  }

  /**
   * Perform a request to the API and convert replies' body from XML into a JS
   * object.
   *
   * @return The body of the reply, decoded from XML via xml2js'
   *     [parseString](https://github.com/Leonidas-from-XIV/node-xml2js#usage).
   *     The reply is only decoded when the request succeeds (`200 <= statusCode
   *     <= 299`)
   */
  public async makeApiCall(
    route: string,
    options?: ApiCallMainOptions & { decodeResponseFromXml?: true }
  ): Promise<any>;

  /**
   * Perform a request to the API and return the retrieved data itself as a
   * Buffer.
   *
   * @return The raw reply as a Buffer if the response status is between 200 and
   *     299.
   */
  public async makeApiCall(
    route: string,
    options?: ApiCallMainOptions & { decodeResponseFromXml: false }
  ): Promise<Buffer>;

  /**
   * Perform a request to the API and return the replies body (by default
   * decoded from XML).
   *
   * @param route  route to which the request will be sent
   * @param options Additional options for further control. By default the
   *     request is a [[GET|RequestMethod.GET]] request with no payload and the
   *     response is assumed to be XML.
   *
   * @throw An [[ApiError]] if the API replied with a status code less than
   *     `200` or more than `299`.
   */
  public async makeApiCall(
    route: string,
    options?: ApiCallOptions
  ): Promise<any> {
    const url = new URL(route, this.url);
    const reqMethod =
      options?.method === undefined ? RequestMethod.GET : options.method;
    assert(
      reqMethod !== undefined,
      "request method in reqMethod must not be undefined"
    );

    return new Promise((resolve, reject) => {
      const req = this.request(
        url,
        {
          auth: this.headers,
          ca: this.serverCaCertificate,
          headers: { cookie: this.cookies },
          method: reqMethod
        },
        (response) => {
          const body: any[] = [];

          response.on("data", (chunk) => {
            body.push(chunk);
          });

          // handle errors in the request here, because the API returns more
          // detailed error messages in the body, but the body is not available
          // until the "end" event occurs
          response.on("end", () => {
            const cookies = response.headers["set-cookie"];
            if (cookies !== undefined) {
              this.cookies = cookies;
            }

            const finish = (err: Error | null, payload: any): void => {
              if (err) {
                reject(err);
              }
              if (response.statusCode! < 200 || response.statusCode! > 299) {
                reject(
                  new ApiError(response.statusCode!, url, reqMethod, payload)
                );
              }
              resolve(payload);
            };

            if (
              options?.decodeResponseFromXml !== undefined &&
              !options.decodeResponseFromXml
            ) {
              finish(null, Buffer.concat(body));
            } else {
              newXmlParser().parseString(body.join(""), finish);
            }
          });
        }
      );
      req.on("error", (err) => reject(err));

      if (options?.payload !== undefined) {
        const payload =
          options.sendPayloadAsRaw === undefined || !options.sendPayloadAsRaw
            ? Buffer.from(newXmlBuilder().buildObject(options.payload))
            : options.payload;
        // obs expects that if it receives data, that the content type is
        // 'application/octet-stream'
        req.setHeader("Content-Type", "application/octet-stream");
        // It is absolutely crucial to set the content-length header field!
        // Otherwise node will use chunked transfers and OBS chokes on these (at
        // least when using http connections).
        // See also: https://github.com/openSUSE/open-build-service/issues/9329
        req.setHeader("Content-Length", payload.length);
        req.write(payload);
      }
      req.end();
    });
  }
}
