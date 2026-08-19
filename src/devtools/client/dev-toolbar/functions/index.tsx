import { createMemo, createSignal, For, Loading, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { BODY_FORMAT_FILE_KEY, BODY_FORMAT_KEY, BodyFormat } from './body-format.js';
import { Badge } from '../../ui/Badge.js';
import IconButton from '../../ui/IconButton.js';
import Placeholder from '../../ui/Placeholder.js';
import { Section } from '../../ui/Section.js';
import { Select, SelectOption } from '../../ui/Select.js';
import { Tab, TabGroup, TabList, TabPanel } from '../../ui/Tabs.js';
import { Text } from '../../ui/Text.js';
import { ArrowLeftIcon, FunctionIcon, TrashIcon } from '../icons.js';
import { BlobViewer } from './BlobViewer.js';
import { FormDataViewer } from './FormDataViewer.js';
import { HeadersViewer } from './HeadersViewer.js';
import { HexViewer } from './HexViewer.js';
import { PropertySeparator, SerovalValue } from './SerovalValue.js';
import { SerovalViewer } from './SerovalViewer.js';
import './styles.css';
import { type ServerFunctionRequest, type ServerFunctionResponse } from './tracker.js';
import { URLSearchParamsViewer } from './URLSearchParamsViewer.js';

async function getFile(source: Response | Request): Promise<File> {
  const formData = await source.formData();
  const file = formData.get(BODY_FORMAT_FILE_KEY);
  if (!(file && file instanceof File)) {
    throw new Error('invalid file input');
  }
  return file;
}

interface JsonViewerProps {
  source: Promise<string>;
}

// Plain-JSON bodies (JSON-safe argument lists go over the wire as raw JSON).
function JsonViewer(props: JsonViewerProps): JSX.Element {
  const data = createMemo(async () => {
    const text = await props.source;
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  });

  return (
    <Loading>
      <Show when={data()} keyed>
        {(current) => (
          <pre data-solid-json-viewer>
            <Text options={{ size: 'xs', font: 'mono' }}>{current}</Text>
          </pre>
        )}
      </Show>
    </Loading>
  );
}

async function getURLSearchParams(source: Response | Request): Promise<URLSearchParams> {
  const text = await source.text();
  return new URLSearchParams(text);
}

interface ContentViewerProps {
  source: ServerFunctionRequest | ServerFunctionResponse;
}

function ContentViewer(props: ContentViewerProps): JSX.Element {
  return (
    <>
      <Section title="Headers">
        <HeadersViewer headers={props.source.source.headers} />
      </Section>
      <Section title="Body">
        {(() => {
          const source = props.source.source.clone();
          const startType = source.headers.get(BODY_FORMAT_KEY);
          const contentType = source.headers.get('Content-Type');
          switch (true) {
            case startType === BodyFormat.Serialized:
              return <SerovalViewer stream={source} />;
            case startType === BodyFormat.Json:
            case contentType?.startsWith('application/json'):
              return <JsonViewer source={source.text()} />;
            case startType === BodyFormat.String:
              return <HexViewer bytes={source.bytes()} />;
            case startType === BodyFormat.File:
              return <BlobViewer source={getFile(source)} />;
            case startType === BodyFormat.FormData:
            case contentType?.startsWith('multipart/form-data'):
              return <FormDataViewer source={source.formData()} />;
            case startType === BodyFormat.URLSearchParams:
            case contentType?.startsWith('application/x-www-form-urlencoded'):
              return <URLSearchParamsViewer source={getURLSearchParams(source)} />;
            case startType === BodyFormat.Blob:
              return <BlobViewer source={source.blob()} />;
            case startType === BodyFormat.ArrayBuffer:
            case startType === BodyFormat.Uint8Array:
              return <HexViewer bytes={source.bytes()} />;
          }
        })()}
      </Section>
    </>
  );
}

interface RequestViewerProps {
  request: ServerFunctionRequest;
}

function convertRequestToEntries(request: Request) {
  return [
    ['Cache', request.cache],
    ['Credentials', request.credentials],
    ['Destination', request.destination],
    ['Integrity', request.integrity],
    ['Keep Alive', request.keepalive],
    ['Mode', request.mode],
    ['Redirect', request.redirect],
    ['Referrer', request.referrer],
    ['Referrer Policy', request.referrerPolicy],
    ['URL', request.url],
  ];
}

function RequestViewer(props: RequestViewerProps): JSX.Element {
  return (
    <TabPanel value="request">
      <Section title="Information">
        <For each={convertRequestToEntries(props.request.source)}>
          {([key, value]) => (
            <div data-solid-property>
              <Text options={{ size: 'xs', weight: 'semibold', wrap: 'nowrap' }}>{key}</Text>
              <PropertySeparator />
              <SerovalValue value={value} />
            </div>
          )}
        </For>
      </Section>
      <ContentViewer source={props.request} />
    </TabPanel>
  );
}

interface ResponseViewerProps {
  request: ServerFunctionRequest;
  response?: ServerFunctionResponse;
}

function convertResponseToEntries(response: Response) {
  return [
    ['OK', response.ok],
    ['Redirected', response.redirected],
    ['Status', response.status],
    ['Status Text', response.statusText],
    ['Type', response.type],
    ['URL', response.url],
  ];
}

function ResponseViewer(props: ResponseViewerProps): JSX.Element {
  return (
    <TabPanel value="response">
      <Show when={props.response}>
        {(instance) => (
          <>
            <Section title="Information">
              <For each={convertResponseToEntries(instance().source)}>
                {([key, value]) => (
                  <div data-solid-property>
                    <Text options={{ size: 'xs', weight: 'semibold', wrap: 'nowrap' }}>{key}</Text>
                    <PropertySeparator />
                    <SerovalValue value={value} />
                  </div>
                )}
              </For>
              <div data-solid-property>
                <Text options={{ size: 'xs', weight: 'semibold', wrap: 'nowrap' }}>Timing</Text>
                <PropertySeparator />
                <SerovalValue
                  value={`${((instance().time - props.request.time) / 1000).toFixed(2)}s`}
                />
              </div>
            </Section>
            <ContentViewer source={instance()} />
          </>
        )}
      </Show>
    </TabPanel>
  );
}

export interface ServerFunctionInstance {
  request: ServerFunctionRequest;
  response?: ServerFunctionResponse;
}

interface ServerFunctionInstanceDetailProps {
  value: ServerFunctionInstance;
}

function ServerFunctionInstanceDetail(props: ServerFunctionInstanceDetailProps) {
  return (
    <>
      <span data-solid-functions-instance-detail>
        <Badge type="info">{props.value.request.source.method}</Badge>
        <Text title={props.value.request.id} options={{ size: 'xs' }}>
          {props.value.request.meta?.name ?? props.value.request.id}
        </Text>
      </span>
      <Show when={props.value.response}>
        {(response) => {
          if (response().source.ok) {
            return <Badge type="success">{response().source.status}</Badge>;
          }
          return <Badge type="failure">{response().source.status}</Badge>;
        }}
      </Show>
    </>
  );
}

interface ServerFunctionInstanceViewerProps {
  instance: ServerFunctionInstance;
  onDelete: () => void;
  onReturn: () => void;
}

function ServerFunctionInstanceViewer(props: ServerFunctionInstanceViewerProps): JSX.Element {
  const [tab, setTab] = createSignal<'request' | 'response'>('request');
  return (
    <div data-solid-function-instance-viewer>
      <div data-solid-function-instance-viewer-nav>
        <div data-solid-function-instance-viewer-nav-left>
          <IconButton onClick={props.onReturn}>
            <ArrowLeftIcon title="Go Back" />
          </IconButton>
          <div>
            <ServerFunctionInstanceDetail value={props.instance} />
          </div>
        </div>
        <div>
          <IconButton onClick={props.onDelete}>
            <TrashIcon title="Delete instance" />
          </IconButton>
        </div>
      </div>
      <div data-solid-function-instance-viewer-content>
        <TabGroup horizontal value={tab()} onChange={(value) => setTab(value ?? 'request')}>
          <TabList>
            <Tab value="request">Request</Tab>
            <Tab value="response">Response</Tab>
          </TabList>
          <RequestViewer request={props.instance.request} />
          <ResponseViewer request={props.instance.request} response={props.instance.response} />
        </TabGroup>
      </div>
    </div>
  );
}

function EmptyServerFunctions(): JSX.Element {
  return (
    <Placeholder>
      <Text options={{ size: 'xs' }}>No server function calls detected.</Text>
    </Placeholder>
  );
}

export interface ServerFunctionViewerProps {
  instances: Record<string, ServerFunctionInstance | undefined>;
  onDeleteInstance: (value: string) => void;
  show?: boolean;
}

export function ServerFunctionViewer(props: ServerFunctionViewerProps): JSX.Element {
  const [currentInstance, setCurrentInstance] = createSignal<string>();

  const keys = createMemo(() => Object.keys(props.instances));

  return (
    <Show when={props.show}>
      <div data-solid-dev-toolbar-panel>
        <div data-solid-functions-viewer>
          <Show when={currentInstance()}>
            {(value) => (
              <Show when={props.instances[value()]}>
                {(instance) => (
                  <ServerFunctionInstanceViewer
                    instance={instance()}
                    onReturn={() => {
                      setCurrentInstance(undefined);
                    }}
                    onDelete={() => {
                      props.onDeleteInstance(value());
                    }}
                  />
                )}
              </Show>
            )}
          </Show>
          <Show when={!currentInstance()}>
            <div data-solid-functions-nav>
              <FunctionIcon title="Server functions" />
              <Text options={{ size: 'sm' }}>Server functions</Text>
            </div>
            <div data-solid-functions-instances-container>
              <Show when={keys().length} fallback={<EmptyServerFunctions />}>
                <Select
                  data-solid-functions-instances
                  horizontal={false}
                  value={currentInstance()}
                  onChange={(current) => setCurrentInstance(current)}
                >
                  <For each={keys()}>
                    {(instance) => (
                      <SelectOption value={instance}>
                        <Show when={props.instances[instance]}>
                          {(current) => <ServerFunctionInstanceDetail value={current()} />}
                        </Show>
                      </SelectOption>
                    )}
                  </For>
                </Select>
              </Show>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
}
