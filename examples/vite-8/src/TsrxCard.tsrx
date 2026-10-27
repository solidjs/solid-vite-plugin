export async function saveCard() {
  "use server";
  return "saved";
}

export function TsrxCard(props: { label: string }) @{
  <>
    <style>
      .card {
        color: rgb(12, 34, 56);
      }

      .unused {
        color: red;
      }
    </style>
    <section data-testid="tsrx-card" data-server-function={typeof saveCard} class="card">
      {props.label}
    </section>
  </>
}
