import { CartItemListTypeInfo } from './.keystone/schema-types';
// @ts-ignore
import { getItem, getItems, deleteItems } from '@keystonejs/server-side-graphql-client';
import { graphQLSchemaExtension } from '@keystone-next/keystone/schema';
import stripe from './lib/stripe';
const graphql = String.raw;

export const extendGraphqlSchema = graphQLSchemaExtension({
  typeDefs: `
    type Mutation {
      addToCart(productId: ID): CartItem
      checkout(token: String!): Order
    }
  `,
  resolvers: {
    Mutation: {
      checkout: async (root: any, { token }: { token: string }, context: any) => {
        const { session } = context;
        // 1. Query the current user and make sure they are signed in
        const userId = session.itemId;
        if (!userId) throw new Error('You must be signed in to complete this order.');

        // FIXME: Use the new graphQL API when it's available
        const User = await getItem({
          context,
          listKey: 'User',
          itemId: userId,
          returnFields: graphql`
            id
            name
            email
            cart {
              id
              quantity
              product { name price id description photo {
                image {
                  id publicUrlTransformed
                }
              } }
            }`,
        });

        // 2. recalculate the total for the price
        const amount = User.cart.reduce(
          (tally: number, cartItem: any) => tally + cartItem.product.price * cartItem.quantity,
          0
        );
        console.log(`Going to charge for a total of ${amount}`);

        // 3. Create the Payment Intent, given the Payment Method ID
        // by passing confirm: true, We do stripe.paymentIntent.create() and stripe.paymentIntent.confirm() in 1 go.
        // You can bypass stripe by using this:
        // const charge = { id: `fake-charge-${Date.now()}`, amount, token };
        const charge = await stripe.paymentIntents.create({
          amount,
          currency: 'USD',
          confirm: true,
          payment_method: token,
        }).catch(err => {
          console.log('shoot!');
          console.log(err);
        }) as any; // TODO: Stripe Type?
        console.log(`Back from stripe!`, charge.id);

        // 4. Convert the CartItems to OrderItems
        // TODO Type CartItem and OrderItem. Can they be generated?
        const orderItems = User.cart.map((cartItem) => {
          const orderItem = {
            name: cartItem.product.name,
            description: cartItem.product.description,
            price: cartItem.product.price,
            quantity: cartItem.quantity,
            image: { connect: { id: cartItem.product.photo.image.id } },
            user: { connect: { id: userId } },
          };
          return orderItem;
        });
        console.dir(orderItems, { depth: null });
        // 5. create the Order
        const order = await context.lists.Order.createOne({
          data: {
            total: charge.amount,
            charge: `${charge.id}`,
            // TODO create array of items causes error
            // message":"Unable to create and/or connect 2 Order.items<OrderItem>
            items: { create: orderItems },
            user: { connect: { id: userId } },
          },
        });
        // 6. Clean up - clear the users cart, delete cartItems
        const cartItemIds = User.cart.map((cartItem: any) => cartItem.id);
        await deleteItems({ context, listKey: 'CartItem', items: cartItemIds });

        // 7. Return the Order to the client
        return order;
      },
      addToCart: async (root: any, { productId }: { productId: string }, context: any) => {
        const { session } = context;
        // 1. Make sure they are signed in
        const userId = session.itemId;
        if (!userId) {
          throw new Error('You must be signed in soooon');
        }
        // 2. Query the users current cart, to see if they already have that item
        const allCartItems = await getItems({
          context,
          where: { user: { id: userId }, product: { id: productId } },
          listKey: 'CartItem',
          returnFields: 'id quantity',
        });

        // 3. Check if that item is already in their cart and increment by 1 if it is
        const [existingCartItem] = allCartItems;
        if (existingCartItem) {
          const { quantity } = existingCartItem;
          console.log(`There are already ${quantity} of these items in their cart`);
          return await context.lists.CartItem.updateOne({
            id: existingCartItem.id,
            data: { quantity: quantity + 1 },
          });
        } else {
          // 4. If its not, create a fresh CartItem for that user!
          return await context.lists.CartItem.createOne({
            data: {
              product: { connect: { id: productId } },
              user: { connect: { id: userId } },
            },
          });
        }
      },
    },
  },
});
