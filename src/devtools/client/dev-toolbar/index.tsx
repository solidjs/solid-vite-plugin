import type { JSX } from '@solidjs/web';
import { clientOnly, Portal } from '@solidjs/web';
import { createEffect, createSignal, Errored, onSettled } from 'solid-js';
import { Toolbar } from 'terracotta/toolbar';
import version from '../version.js';
import IconButton from '../ui/IconButton.js';
import { Text } from '../ui/Text.js';
import { type ServerFunctionInstance, ServerFunctionViewer } from './functions/index.js';
import { captureServerFunctionCall } from './functions/tracker.js';
import { ErrorIcon, FunctionIcon, SolidIcon } from './icons.js';
import './index.css';

const ErrorViewer = clientOnly(() => import('./error-viewer/index.js'), { lazy: true });

export interface DevToolbarProps {
  children?: JSX.Element;
}

export function DevToolbar(props: DevToolbarProps) {
  const [ref, setRef] = createSignal<HTMLElement>();

  createEffect(
    () => ref(),
    (current) => {
      if (!current) return;
      let isDown = false;

      let offsetX = 0;
      let offsetY = 0;

      let currentX = 0;
      let currentY = 0;

      let centerX = 0;
      let centerY = 0;

      const resetPosition = () => {
        current.style.top = 'auto';
        current.style.left = 'auto';
        current.style.bottom = 'auto';
        current.style.right = 'auto';
      };

      let isDirty = false;

      const ac = new AbortController();

      current.addEventListener(
        'mousedown',
        (e) => {
          isDown = true;

          const rect = current.getBoundingClientRect();

          currentX = rect.left;
          currentY = rect.top;

          offsetX = e.clientX - currentX;
          offsetY = e.clientY - currentY;

          centerX = rect.width / 2;
          centerY = rect.height / 2;

          isDirty = true;
        },
        {
          signal: ac.signal,
        },
      );

      window.addEventListener(
        'mouseup',
        () => {
          if (isDown && !isDirty) {
            const preferredAnchorX = currentX + centerX < window.innerWidth / 2 ? 'left' : 'right';
            const preferredAnchorY = currentY + centerY < window.innerHeight / 2 ? 'top' : 'bottom';

            resetPosition();

            current.style[preferredAnchorX] = '0px';
            current.style[preferredAnchorY] = '0px';

            current.style.flexDirection =
              preferredAnchorY === 'bottom' ? 'column-reverse' : 'column';
            current.style.alignItems = preferredAnchorX === 'left' ? 'flex-start' : 'flex-end';
          }
          isDown = false;
        },
        {
          signal: ac.signal,
        },
      );

      window.addEventListener(
        'mousemove',
        (e) => {
          if (isDown) {
            if (isDirty) {
              resetPosition();
              isDirty = false;
            }
            currentX = e.clientX - offsetX;
            currentY = e.clientY - offsetY;

            current.style.left = `${currentX}px`;
            current.style.top = `${currentY}px`;
          }
        },
        {
          signal: ac.signal,
          passive: true,
        },
      );

      return () => {
        ac.abort();
      };
    },
  );

  const [content, setContent] = createSignal<'fn' | 'err' | undefined>(undefined);

  function toggleContent(value: 'fn' | 'err') {
    if (content() === value) {
      setContent(undefined);
    } else {
      setContent(value);
    }
  }

  const [errors, setErrors] = createSignal<unknown[]>([]);

  function resetError() {
    setErrors([]);
  }

  function pushError(error: unknown) {
    console.error(error);
    setErrors((current) => [error, ...current]);

    setContent('err');
  }

  onSettled(() => {
    const onErrorEvent = (error: ErrorEvent) => {
      if (!error.error && error.message?.startsWith('ResizeObserver loop')) {
        return;
      }
      pushError(error.error ?? error);
    };

    window.addEventListener('error', onErrorEvent);

    return () => {
      window.removeEventListener('error', onErrorEvent);
    };
  });

  const [instances, setInstances] = createSignal<
    Record<string, ServerFunctionInstance | undefined>
  >({});

  onSettled(() =>
    captureServerFunctionCall((call) => {
      queueMicrotask(() => {
        setInstances((current) => ({
          ...current,
          [call.instance]:
            call.type === 'request'
              ? { ...current[call.instance], request: call }
              : ({ ...current[call.instance], response: call } as ServerFunctionInstance),
        }));
      });
    }),
  );

  return (
    <>
      <Portal>
        <div data-solid-dev-toolbar ref={setRef}>
          <Toolbar>
            <div>
              <IconButton onClick={() => toggleContent('err')} disabled={errors().length === 0}>
                <ErrorIcon title="View Errors" />
              </IconButton>
              <IconButton onClick={() => toggleContent('fn')}>
                <FunctionIcon title="View Server Functions" />
              </IconButton>
            </div>
            <div>
              <SolidIcon title="Solid Vite Version" />
              <div data-solid-dev-toolbar-version>
                <Text options={{ size: 'xs', weight: 'semibold', font: 'mono', wrap: 'nowrap' }}>
                  {version}
                </Text>
              </div>
            </div>
          </Toolbar>
          <ErrorViewer show={content() === 'err'} errors={errors()} resetError={resetError} />
          <ServerFunctionViewer
            show={content() === 'fn'}
            instances={instances()}
            onDeleteInstance={(value) => {
              setInstances((current) => {
                const next = { ...current };
                delete next[value];
                return next;
              });
            }}
          />
        </div>
      </Portal>
      <Errored
        fallback={(error) => {
          const err = error();
          queueMicrotask(() => pushError(err));
          return <></>;
        }}
      >
        {props.children}
      </Errored>
    </>
  );
}
