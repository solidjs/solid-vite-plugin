import { onSettled } from "solid-js";
import { CounterProvider, useCounter } from "./CounterContext";
import { title } from './UnusedLazyImporter';
import { TsrxCard } from './TsrxCard.tsrx';

function Count() {
  const counter = useCounter();
  onSettled(() => {
    console.log('Mounted Count');
    return () => console.log('Unmounted Count');
  });
  return (
    <h1>{title}: {counter.value()}</h1>
  );
}

function Increment() {
  const counter = useCounter();
  onSettled(() => {
    console.log('Mounted Increment');
    return () => console.log('Unmounted Increment');
  });
  return (
    <button onClick={counter.increment}>
      Increment
    </button>
  );
}

function Decrement() {
  const counter = useCounter();
  onSettled(() => {
    console.log('Mounted Decrement');
    return () => console.log('Unmounted Decrement');
  });
  return (
    <button onClick={counter.decrement}>
      Decrement
    </button>
  );
}

export default function App() {
  onSettled(() => {
    console.log('Mounted App');
    return () => console.log('Unmounted App');
  });

  return (
    <CounterProvider>
      <Count />
      <Increment />
      <Decrement />
      <TsrxCard label="TSRX scoped styles" />
    </CounterProvider>
  );
}
